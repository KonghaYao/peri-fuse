/**
 * Best-effort JSONL diagnostics. At most two streams exist during rotation and
 * each has a fixed byte budget; backpressure drops new logs until drain.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { gatewayEnv } from "../env.js";
import { isSlow } from "./judge.js";
import type { SlowLogEvent } from "./types.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_BUFFER_BYTES = 64 * 1024;
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

interface StreamState {
  stream: Writable;
  day: string;
  blocked: boolean;
  closePromise?: Promise<void>;
}

interface WriterOptions {
  createStream?: (filePath: string) => Writable;
  closeTimeoutMs?: number;
}

export class SlowLogWriter {
  private active: StreamState | null = null;
  private retiring: StreamState | null = null;
  private initialized = false;
  private closing: Promise<void> | null = null;
  private dropped = 0;
  private lastDropWarning = 0;

  constructor(private readonly options: WriterOptions = {}) {}

  private init(): void {
    if (this.initialized) return;
    fs.mkdirSync(gatewayEnv.slowLogDir, { recursive: true });
    this.cleanup();
    this.initialized = true;
  }

  /** Never throws: failures in diagnostics must not affect the proxy path. */
  writeIfSlow(event: SlowLogEvent): void {
    if (isSlow(event, gatewayEnv.slowLogThresholdMs)) this.write(event);
  }

  /** Returns false when the bounded writer cannot accept another log. */
  write(event: SlowLogEvent): boolean {
    try {
      if (this.closing) return this.drop();
      this.init();
      const day = dayOf(event.endTime);
      if (this.active?.day !== day && !this.rotate(day)) return this.drop();
      const state = this.active!;
      if (state.blocked || state.stream.destroyed) return this.drop();

      // Bound strings before serialization, including upstream error messages.
      const fields = {
        ts: event.endTime.toISOString(),
        projectId: event.projectId,
        callType: event.callType,
        apiKey: event.apiKey,
        model: event.model,
        modelGroup: event.modelGroup,
        provider: event.provider,
        stream: event.stream ?? false,
        latencyMs: event.latencyMs,
        ttftMs: event.ttftMs,
        thresholdMs: gatewayEnv.slowLogThresholdMs,
        status: event.status,
        errorMessage: event.errorMessage,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        spend: event.spend,
        traceId: event.traceId,
      };
      const bounded = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          typeof value === "string" ? value.slice(0, 2048) : value,
        ]),
      );
      const line = `${JSON.stringify(bounded)}\n`;
      const bytes = Buffer.byteLength(line);
      if (state.stream.writableLength + bytes > MAX_BUFFER_BYTES) return this.drop();
      const ready = state.stream.write(line, (error) => {
        if (error) this.drop();
      });
      if (!ready) state.blocked = true;
      return true;
    } catch (error) {
      console.error("[slow-log] write failed:", error);
      return this.drop();
    }
  }

  private drop(): false {
    this.dropped++;
    if (Date.now() - this.lastDropWarning >= 60_000) {
      this.lastDropWarning = Date.now();
      console.warn(
        `[slow-log] Dropped diagnostic logs: ${this.dropped} (writer unavailable or full)`,
      );
    }
    return false;
  }

  private rotate(day: string): boolean {
    // A stalled filesystem cannot accumulate streams through repeated rotations.
    if (this.retiring) return false;
    if (this.active) {
      const previous = this.active;
      this.retiring = previous;
      this.active = null;
      void this.closeState(previous).then(() => {
        if (this.retiring === previous) this.retiring = null;
      });
    }
    const filePath = path.join(gatewayEnv.slowLogDir, `slow-${day}.log`);
    const stream = this.options.createStream
      ? this.options.createStream(filePath)
      : fs.createWriteStream(filePath, { flags: "a", highWaterMark: MAX_BUFFER_BYTES });
    const state: StreamState = { stream, day, blocked: false };
    this.active = state;
    stream.on("drain", () => {
      state.blocked = false;
    });
    stream.on("error", (error) => {
      console.error("[slow-log] stream error:", error);
      if (this.active === state) this.active = null;
      stream.destroy();
    });
    this.cleanup();
    return true;
  }

  /** Process-local diagnostics: buffers include the stream being rotated out. */
  stats(): { dropped: number; bufferedBytes: number; streams: number } {
    const states = [this.active, this.retiring].filter((state) => state !== null);
    return {
      dropped: this.dropped,
      bufferedBytes: states.reduce((bytes, state) => bytes + state.stream.writableLength, 0),
      streams: states.length,
    };
  }

  /** Delete log files whose mtime is older than the retention window. */
  cleanup(): void {
    const cutoff = Date.now() - gatewayEnv.slowLogRetentionDays * RETENTION_MS;
    for (const name of fs.readdirSync(gatewayEnv.slowLogDir)) {
      if (!name.startsWith("slow-") || !name.endsWith(".log")) continue;
      const filePath = path.join(gatewayEnv.slowLogDir, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch {
        // File disappeared between readdir and unlink — ignore.
      }
    }
  }

  private closeState(state: StreamState): Promise<void> {
    if (state.closePromise) return state.closePromise;
    state.closePromise = new Promise<void>((resolve) => {
      const stream = state.stream;
      if (stream.destroyed || stream.writableFinished) return resolve();
      const done = () => {
        clearTimeout(timer);
        stream.off("finish", done);
        stream.off("close", done);
        stream.off("error", done);
        resolve();
      };
      const timer = setTimeout(() => {
        console.warn("[slow-log] Closing stalled log stream after timeout");
        stream.destroy(new Error("Slow log shutdown timeout"));
        done();
      }, this.options.closeTimeoutMs ?? 5000);
      timer.unref();
      stream.once("finish", done);
      stream.once("close", done);
      stream.once("error", done);
      stream.end();
    });
    return state.closePromise;
  }

  /** Flush both rotating streams; a stalled disk cannot block shutdown forever. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const states = [this.active, this.retiring].filter((state) => state !== null);
    const closing = Promise.all(states.map((state) => this.closeState(state))).then(() => {
      this.active = null;
      this.retiring = null;
      this.closing = null;
    });
    this.closing = closing;
    return closing;
  }
}

export const slowLogWriter = new SlowLogWriter();
