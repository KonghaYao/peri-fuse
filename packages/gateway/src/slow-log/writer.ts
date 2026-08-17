/**
 * SlowLogWriter — appends slow requests to slow-YYYY-MM-DD.log (JSON Lines)
 * under the configured slow-log directory. A single append stream keeps lines
 * from interleaving. Non-blocking by design: write failures are logged, never
 * thrown, so diagnostics never affect the proxy path.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { gatewayEnv } from "../env.js";
import { isSlow } from "./judge.js";
import type { SlowLogEvent } from "./types.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

class SlowLogWriter {
  private stream: fs.WriteStream | null = null;
  private currentDay = "";
  private initialized = false;

  private init(): void {
    if (this.initialized) return;
    this.initialized = true;
    fs.mkdirSync(gatewayEnv.slowLogDir, { recursive: true });
    this.cleanup();
  }

  /**
   * Write a slow request if it exceeds the configured threshold.
   * Never throws — diagnostic data must not affect the proxy path.
   */
  writeIfSlow(event: SlowLogEvent): void {
    try {
      if (!isSlow(event, gatewayEnv.slowLogThresholdMs)) return;
      this.write(event);
    } catch (err) {
      console.error("[slow-log] write failed:", err);
    }
  }

  /** Append a slow request line (no threshold check). */
  write(event: SlowLogEvent): void {
    this.init();
    const day = dayOf(event.endTime);
    if (day !== this.currentDay) this.rotate(day);

    const line = JSON.stringify({
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
    });

    this.stream!.write(`${line}\n`);
  }

  private rotate(day: string): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.currentDay = day;
    const filePath = path.join(gatewayEnv.slowLogDir, `slow-${day}.log`);
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
    this.stream.on("error", (err) => console.error("[slow-log] stream error:", err));
    this.cleanup();
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

  /** Flush and close the append stream (graceful shutdown / tests). */
  async close(): Promise<void> {
    if (!this.stream) return;
    const stream = this.stream;
    this.stream = null;
    this.currentDay = "";
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}

export const slowLogWriter = new SlowLogWriter();
