/**
 * Read-only worker pool for telemetry SELECT queries.
 *
 * better-sqlite3 is a synchronous API: every aggregate executed on the main
 * thread freezes the whole HTTP server for its duration. WAL mode permits
 * concurrent readers on the same database file, so heavy reads are offloaded
 * to a small pool of worker threads (each with its own READ-ONLY connection)
 * while writes stay on the main connection. Result: slow cold queries no
 * longer queue up fast ones.
 *
 * The worker script is an inline eval string on purpose: no build-artifact
 * path resolution is needed, so it behaves identically under `tsx` (dev) and
 * compiled `dist` (production).
 *
 * Memory stays bounded: each worker uses an 8 MiB page cache (vs 64 MiB on
 * the main connection) and the pool is small by default. Override with
 * PERIFUSE_READ_WORKERS (0 disables the pool entirely).
 */

import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { logger } from "../logger";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("cache_size = -8000"); // 8 MiB per worker keeps RSS low
const stmtCache = new Map();
parentPort.on("message", (msg) => {
  const { id, sql, params } = msg;
  try {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      if (stmtCache.size > 256) stmtCache.clear();
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    const rows = stmt.all(params ?? {});
    parentPort.postMessage({ id, ok: true, rows });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
parentPort.postMessage({ type: "ready" });
`;

type Pending = {
  resolve: (rows: unknown[]) => void;
  reject: (error: Error) => void;
};

class ReadWorker {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(dbPath: string, betterSqlitePath: string) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, betterSqlitePath },
    });
    this.worker.on(
      "message",
      (msg: { type?: string; id?: number; ok?: boolean; rows?: unknown[]; error?: string }) => {
        if (msg.type === "ready") return;
        const p = this.pending.get(msg.id as number);
        if (!p) return;
        this.pending.delete(msg.id as number);
        if (msg.ok) p.resolve(msg.rows ?? []);
        else p.reject(new Error(msg.error ?? "read worker query failed"));
      },
    );
    this.worker.on("error", (err) => {
      logger.error("[SqliteReadPool] worker error", err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const id = ++this.seq;
    return new Promise<T[]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (rows: unknown[]) => void, reject });
      this.worker.postMessage({ id, sql, params });
    });
  }

  /** Number of in-flight queries; used for least-loaded dispatch. */
  get load(): number {
    return this.pending.size;
  }

  terminate(): void {
    void this.worker.terminate();
  }
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
  // Default: roughly one worker per two cores (capped at 4). Load testing
  // showed 4 workers lifting 128-concurrency mixed-read throughput ~4x while
  // keeping RSS growth bounded (~40-50 MiB per worker).
  return Math.min(4, Math.max(2, Math.floor(availableParallelism() / 2)));
}

export class SqliteReadPool {
  private workers: ReadWorker[] = [];

  constructor(dbPath: string, size: number) {
    const nodeRequire = createRequire(__filename);
    const betterSqlitePath = nodeRequire.resolve("better-sqlite3");
    for (let i = 0; i < size; i++) {
      this.workers.push(new ReadWorker(dbPath, betterSqlitePath));
    }
    logger.info(`[SqliteReadPool] Started ${size} read-only worker(s) for ${dbPath}`);
  }

  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    let best = this.workers[0];
    for (const w of this.workers) {
      if (w.load < best.load) best = w;
    }
    return best.query<T>(sql, params);
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
