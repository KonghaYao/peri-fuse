/** Bounded, cancellable read-only workers. Only one query is sent to each worker. */
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { logger } from "../logger";
import { decodeOwnedSnapshot, encodeOwnedSnapshot } from "../utils/owned-snapshot";
import { SQLITE_READ_WORKER_SOURCE } from "./sqlite-read-worker-source";
import { TelemetryQueryError } from "./telemetry-query-context";
import type { TelemetryQueryOpts } from "./types";

export const DEFAULT_MAX_RESULT_ROWS = 100_000;
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024 * 1024;

type ReadOptions = Pick<
  TelemetryQueryOpts,
  "timeoutMs" | "signal" | "maxResultRows" | "maxResultBytes"
>;
type Request = {
  id: number;
  sql: string;
  params: Record<string, unknown>;
  options: ReadOptions;
  bytes: number;
  resolve: (rows: unknown[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
};
type Slot = {
  worker?: Worker;
  state: "starting" | "idle" | "busy" | "stopping" | "stopped";
  request?: Request;
  startupTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  failures: number;
};

export interface SqliteReadPoolOptions {
  maxPending?: number;
  maxPendingBytes?: number;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  restartDelayMs?: number;
}

/** True when the SQL is a pure read (SELECT / WITH ... SELECT). */
export function isReadOnlySql(sql: string): boolean {
  return /^\s*(--[^\n]*\n\s*)*(SELECT|WITH)\b/i.test(sql);
}

export function resolveReadPoolSize(): number {
  const raw = process.env.PERIFUSE_READ_WORKERS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.max(0, Math.min(8, n));
  }
  return Math.min(4, Math.max(2, Math.floor(availableParallelism() / 2)));
}

export class SqliteReadPool {
  private readonly slots: Slot[];
  private readonly requests = new Map<number, Request>();
  private readonly options: Required<SqliteReadPoolOptions>;
  private readonly betterSqlitePath = createRequire(__filename).resolve("better-sqlite3");
  private seq = 0;
  private pendingBytes = 0;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly dbPath: string,
    size: number,
    options: SqliteReadPoolOptions = {},
  ) {
    if (!Number.isInteger(size) || size < 1 || size > 8) throw new Error("Invalid read pool size");
    this.options = {
      maxPending: 128,
      maxPendingBytes: 16 * 1024 * 1024,
      timeoutMs: 30_000,
      startupTimeoutMs: 10_000,
      restartDelayMs: 100,
      ...options,
    };
    for (const value of Object.values(this.options)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid read pool limit");
    }
    this.slots = Array.from({ length: size }, () => ({ state: "stopped", failures: 0 }));
    for (const slot of this.slots) this.start(slot);
  }

  /** Queued and running requests share capacity; cancelled work is never left in a worker mailbox. */
  query<T>(sql: string, params: Record<string, unknown>, options: ReadOptions = {}): Promise<T[]> {
    // Snapshot limits independently while keeping the cancellation signal live.
    options = {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxResultRows: options.maxResultRows,
      maxResultBytes: options.maxResultBytes,
    };
    if (this.closed)
      return Promise.reject(new TelemetryQueryError("UNAVAILABLE", "SQLite read pool is closed"));
    if (options.signal?.aborted) return Promise.reject(this.abortError());
    if (this.requests.size >= this.options.maxPending) {
      return Promise.reject(new TelemetryQueryError("OVERLOADED", "SQLite read queue is full"));
    }
    const timeout = options.timeoutMs ?? this.options.timeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return Promise.reject(new Error("Invalid SQLite query timeout"));
    }
    for (const limit of [options.maxResultRows, options.maxResultBytes]) {
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        return Promise.reject(new Error("Invalid SQLite result limit"));
      }
    }
    let bytes: number;
    let snapshot: Buffer;
    try {
      snapshot = encodeOwnedSnapshot({ sql, params });
      bytes = snapshot.byteLength;
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pendingBytes + bytes > this.options.maxPendingBytes) {
      return Promise.reject(
        new TelemetryQueryError("OVERLOADED", "SQLite read queue byte limit exceeded"),
      );
    }
    params = decodeOwnedSnapshot<{ params: Record<string, unknown> }>(snapshot).params;
    return new Promise<T[]>((resolve, reject) => {
      const id = ++this.seq;
      const request: Request = {
        id,
        sql,
        params,
        options,
        bytes,
        resolve: resolve as (rows: unknown[]) => void,
        reject,
        timer: setTimeout(
          () => this.cancel(request, new TelemetryQueryError("TIMEOUT", "SQLite query timed out")),
          timeout,
        ),
      };
      this.requests.set(id, request);
      this.pendingBytes += bytes;
      if (options.signal) {
        const onAbort = () => this.cancel(request, this.abortError());
        options.signal.addEventListener("abort", onAbort, { once: true });
        request.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.dispatch();
    });
  }

  /** Includes workers being retired: replacement waits for actual thread exit. */
  stats() {
    const active = this.slots.filter((slot) => slot.state === "busy").length;
    return {
      pending: this.requests.size,
      queued: this.requests.size - active,
      active,
      pendingBytes: this.pendingBytes,
      workers: this.slots.map((slot) => slot.state),
      closed: this.closed,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const request of this.requests.values())
      this.settle(request, new TelemetryQueryError("UNAVAILABLE", "SQLite read pool closed"));
    const stops = this.slots.map((slot) => {
      clearTimeout(slot.restartTimer);
      clearTimeout(slot.startupTimer);
      slot.state = "stopping";
      slot.request = undefined;
      return slot.worker?.terminate();
    });
    this.closePromise = Promise.allSettled(stops).then(() => {});
    return this.closePromise;
  }

  private abortError(): Error {
    const error = new Error("SQLite query aborted");
    error.name = "AbortError";
    return error;
  }

  private start(slot: Slot): void {
    if (this.closed) return;
    slot.state = "starting";
    try {
      const worker = new Worker(SQLITE_READ_WORKER_SOURCE, {
        eval: true,
        workerData: { dbPath: this.dbPath, betterSqlitePath: this.betterSqlitePath },
      });
      slot.worker = worker;
      slot.startupTimer = setTimeout(() => {
        this.retire(
          slot,
          new TelemetryQueryError("UNAVAILABLE", "SQLite read worker startup timed out"),
        );
      }, this.options.startupTimeoutMs);
      worker.on(
        "message",
        (message: {
          type?: string;
          id?: number;
          ok?: boolean;
          rows?: unknown[];
          error?: string;
          code?: string;
        }) => {
          if (slot.worker !== worker || slot.state === "stopping" || this.closed) return;
          if (message.type === "ready") {
            clearTimeout(slot.startupTimer);
            slot.state = "idle";
            slot.failures = 0;
          } else {
            const request = slot.request;
            if (!request || request.id !== message.id) return;
            slot.request = undefined;
            slot.state = "idle";
            this.settle(
              request,
              message.ok
                ? undefined
                : message.code === "RESULT_LIMIT"
                  ? new TelemetryQueryError(
                      "RESULT_LIMIT",
                      message.error ?? "SQLite result limit exceeded",
                    )
                  : new Error(message.error ?? "SQLite read failed"),
              message.rows,
            );
          }
          this.dispatch();
        },
      );
      worker.on("error", (error) => {
        logger.error("[SqliteReadPool] worker error", error);
        this.retire(slot, new TelemetryQueryError("UNAVAILABLE", error.message));
      });
      worker.on("exit", (code) => {
        if (slot.worker !== worker) return;
        clearTimeout(slot.startupTimer);
        if (slot.request)
          this.settle(
            slot.request,
            new TelemetryQueryError("UNAVAILABLE", `SQLite read worker exited (${code})`),
          );
        slot.request = undefined;
        slot.worker = undefined;
        slot.state = "stopped";
        this.restart(slot);
      });
    } catch (error) {
      slot.state = "stopped";
      logger.error("[SqliteReadPool] worker startup failed", error);
      this.restart(slot);
    }
  }

  private restart(slot: Slot): void {
    if (this.closed) return;
    const delay = Math.min(5_000, this.options.restartDelayMs * 2 ** Math.min(slot.failures++, 6));
    slot.restartTimer = setTimeout(() => this.start(slot), delay);
    slot.restartTimer.unref?.();
  }

  private dispatch(): void {
    if (this.closed) return;
    const running = new Set(this.slots.map((slot) => slot.request?.id));
    const waiting = [...this.requests.values()].filter((request) => !running.has(request.id));
    for (const slot of this.slots) {
      if (slot.state !== "idle" || !waiting.length) continue;
      const request = waiting.shift()!;
      slot.state = "busy";
      slot.request = request;
      try {
        slot.worker!.postMessage({
          id: request.id,
          sql: request.sql,
          params: request.params,
          maxResultRows: Math.min(
            request.options.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
            DEFAULT_MAX_RESULT_ROWS,
          ),
          maxResultBytes: Math.min(
            request.options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
            DEFAULT_MAX_RESULT_BYTES,
          ),
        });
      } catch (error) {
        this.retire(
          slot,
          new TelemetryQueryError(
            "UNAVAILABLE",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }

  private settle(request: Request, error?: Error, rows: unknown[] = []): void {
    if (!this.requests.delete(request.id)) return;
    this.pendingBytes -= request.bytes;
    clearTimeout(request.timer);
    request.removeAbort?.();
    if (error) request.reject(error);
    else request.resolve(rows);
  }

  private cancel(request: Request, error: Error): void {
    if (!this.requests.has(request.id)) return;
    const slot = this.slots.find((candidate) => candidate.request === request);
    if (slot) this.retire(slot, error);
    else this.settle(request, error);
    this.dispatch();
  }

  private retire(slot: Slot, error: Error): void {
    if (slot.state === "stopping" || slot.state === "stopped") return;
    clearTimeout(slot.startupTimer);
    slot.state = "stopping";
    if (slot.request) this.settle(slot.request, error);
    slot.request = undefined;
    // A synchronous native SQLite call cannot receive a cancellation message.
    // Terminate the thread and wait for exit before starting its replacement.
    void slot.worker?.terminate().catch((terminationError) => {
      logger.error("[SqliteReadPool] worker termination failed", terminationError);
    });
  }
}
