/**
 * SQLite telemetry adapter – stores trace/observation/score data in a local
 * SQLite database file. This is the "lite mode" adapter.
 *
 * Uses better-sqlite3 for synchronous, high-performance local access.
 * Database file: `.langfuse/telemetry.db` (or `LANGFUSE_SQLITE_DB_PATH`).
 *
 * NOTE: This is an initial implementation. Complex ClickHouse-specific queries
 * (aggregations, FINAL deduplication, array operations) will need to be
 * translated to SQLite-compatible SQL in the repository layer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { logger } from "../logger";
import { isSessionSearchAvailable } from "../session-search/schema";
import { SessionSearchStorage } from "../session-search/storage";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_RESULT_ROWS,
  isReadOnlySql,
  resolveReadPoolSize,
  SqliteReadPool,
} from "./sqlite-read-pool";
import { TelemetrySchemaMigrations } from "./sqlite-telemetry-migrations";
import { initializeTelemetrySchema } from "./sqlite-telemetry-schema";
import {
  currentTelemetryQuerySignal,
  recordTelemetryQueryError,
  TelemetryQueryError,
} from "./telemetry-query-context";
import type { TelemetryDBAdapter, TelemetryInsertOpts, TelemetryQueryOpts } from "./types";

const DEFAULT_DB_PATH = ".langfuse/telemetry.db";

export {
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "./trace-metrics-sql";

/** Find the monorepo root by traversing up from CWD looking for pnpm-workspace.yaml */
function findMonorepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to CWD
  return process.cwd();
}

export class SQLiteTelemetryAdapter implements TelemetryDBAdapter {
  private db: Database.Database;
  private readonly dbPath: string;
  private readPool: SqliteReadPool | null = null;
  private readPoolInit = false;
  /** Writes since the last ANALYZE; triggers a re-ANALYZE at the threshold. */
  private analyzeWriteCounter = 0;
  private static readonly ANALYZE_WRITE_THRESHOLD = 50_000;

  constructor(dbPath?: string) {
    const rawPath = dbPath ?? process.env.LANGFUSE_SQLITE_DB_PATH ?? DEFAULT_DB_PATH;
    // Resolve relative paths from the monorepo root so the DB location is
    // consistent regardless of which package's CWD starts the process.
    const resolvedPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(findMonorepoRoot(), rawPath);
    this.dbPath = resolvedPath;

    // Ensure directory exists
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    this.db = new Database(resolvedPath);

    // Performance optimizations for local usage
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("foreign_keys = ON");

    // Initialize schema
    initializeTelemetrySchema(this.db);
    new TelemetrySchemaMigrations(this.db).migrate();
    this.analyzeTables();

    logger.info(`[SQLiteTelemetryAdapter] Database opened at ${resolvedPath}`);
  }

  /**
   * Refresh SQLite query-plan statistics (ANALYZE) for the hot tables.
   *
   * Without ANALYZE the planner falls back to default cost estimates: on a
   * million-row observations table it can pick a low-selectivity index (e.g.
   * idx_obs_start_level via `is_deleted = 0`) over the precise
   * (project_id, trace_id) index, turning a trace point lookup into a
   * full-project scan + temp B-tree (measured: ~1.5s → ~7ms on 1.1M rows).
   * ANALYZE is cheap (~0.1s at 1M+ rows) and runs once at startup; the stats
   * go stale as the DB grows, so re-run on a write-count threshold.
   */
  private analyzeTables(): void {
    try {
      this.db.exec("ANALYZE observations; ANALYZE traces; ANALYZE scores; ANALYZE trace_metrics;");
    } catch (error) {
      logger.error("[SQLiteTelemetryAdapter] ANALYZE failed", error);
    }
  }

  private maybeReanalyze(): void {
    this.analyzeWriteCounter++;
    if (this.analyzeWriteCounter >= SQLiteTelemetryAdapter.ANALYZE_WRITE_THRESHOLD) {
      this.analyzeWriteCounter = 0;
      this.analyzeTables();
    }
  }

  /**
   * Lazily start the read-only worker pool (once). PERIFUSE_READ_WORKERS=0
   * disables it, falling back to synchronous reads on the main connection.
   */
  private getReadPool(): SqliteReadPool | null {
    if (!this.readPoolInit) {
      this.readPoolInit = true;
      const size = resolveReadPoolSize();
      if (size > 0) {
        try {
          this.readPool = new SqliteReadPool(this.dbPath, size);
        } catch (error) {
          logger.error(
            "[SQLiteTelemetryAdapter] Read pool failed to start; using sync reads",
            error,
          );
          this.readPool = null;
        }
      }
    }
    return this.readPool;
  }

  async query<T = Record<string, unknown>>(opts: TelemetryQueryOpts): Promise<T[]> {
    opts = { ...opts, signal: opts.signal ?? currentTelemetryQuerySignal() };
    opts.signal?.throwIfAborted();
    for (const limit of [opts.timeoutMs, opts.maxResultRows, opts.maxResultBytes]) {
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new Error("Invalid SQLite query limit");
      }
    }
    // Offload pure reads to worker threads so heavy aggregates never block the
    // event loop; WAL permits these read-only connections alongside writes.
    if (isReadOnlySql(opts.query)) {
      const pool = this.getReadPool();
      if (pool) {
        try {
          return await pool.query<T>(opts.query, opts.params ?? {}, opts);
        } catch (error) {
          recordTelemetryQueryError(error);
          logger.error(`[SQLiteTelemetryAdapter] Query failed: ${opts.query}`, error);
          throw error;
        }
      }
    }
    try {
      const stmt = this.db.prepare(opts.query);
      const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
      const rows: T[] = [];
      let bytes = 0;
      const maxRows = Math.min(
        opts.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
        DEFAULT_MAX_RESULT_ROWS,
      );
      const maxBytes = Math.min(
        opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
        DEFAULT_MAX_RESULT_BYTES,
      );
      for (const row of stmt.iterate(opts.params ?? {}) as Iterable<Record<string, unknown>>) {
        opts.signal?.throwIfAborted();
        if (Date.now() >= deadline)
          throw new TelemetryQueryError("TIMEOUT", "SQLite query timed out");
        bytes += 64;
        for (const [key, value] of Object.entries(row)) {
          bytes += key.length * 2 + 32;
          bytes +=
            typeof value === "string"
              ? value.length * 2
              : value instanceof Uint8Array
                ? value.byteLength
                : 8;
        }
        if (rows.length >= maxRows || bytes > maxBytes) {
          throw new TelemetryQueryError(
            "RESULT_LIMIT",
            "SQLite query result limit exceeded; paginate or narrow the query",
          );
        }
        rows.push(row as T);
      }
      if (Date.now() >= deadline)
        throw new TelemetryQueryError("TIMEOUT", "SQLite query timed out");
      return rows;
    } catch (error) {
      recordTelemetryQueryError(error);
      logger.error(`[SQLiteTelemetryAdapter] Query failed: ${opts.query}`, error);
      throw error;
    }
  }

  async command(opts: TelemetryQueryOpts): Promise<{ changes: number }> {
    try {
      const stmt = this.db.prepare(opts.query);
      const info = stmt.run(opts.params ?? {});
      return { changes: info.changes };
    } catch (error) {
      logger.error(`[SQLiteTelemetryAdapter] Command failed: ${opts.query}`, error);
      throw error;
    }
  }

  async insert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void> {
    if (opts.records.length === 0) return;

    const columns = Object.keys(opts.records[0] as Record<string, unknown>);
    const placeholders = columns.map((c) => `@${c}`).join(", ");
    const sql = `INSERT OR REPLACE INTO ${opts.table} (${columns.join(", ")}) VALUES (${placeholders})`;

    try {
      const stmt = this.db.prepare(sql);
      const insertMany = this.db.transaction((records: T[]) => {
        for (const record of records) {
          stmt.run(record as Record<string, unknown>);
          this.markSearchDirty(opts.table, record as Record<string, unknown>);
        }
      });
      insertMany(opts.records);
      this.maybeReanalyze();
    } catch (error) {
      logger.error(`[SQLiteTelemetryAdapter] Insert into ${opts.table} failed`, error);
      throw error;
    }
  }

  /**
   * Insert with field-level merge: on PK conflict, only overwrite columns
   * whose incoming value is non-null. Preserves existing data for columns
   * that the new event does not carry.
   */
  async mergeInsert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void> {
    if (opts.records.length === 0) return;

    const columns = Object.keys(opts.records[0] as Record<string, unknown>);
    const placeholders = columns.map((c) => `@${c}`).join(", ");

    // Determine PK columns for the ON CONFLICT target
    const pkColumns =
      opts.table === "traces" ||
      opts.table === "observations" ||
      opts.table === "scores" ||
      opts.table === "dataset_run_items"
        ? ["project_id", "id"]
        : ["id"];

    // Build SET clause: only overwrite when incoming value is non-null
    const updateCols = columns.filter((c) => !pkColumns.includes(c));
    const setClauses = updateCols
      .map(
        (c) =>
          `${c} = CASE WHEN excluded.${c} IS NOT NULL THEN excluded.${c} ELSE ${opts.table}.${c} END`,
      )
      .join(", ");

    const sql = `INSERT INTO ${opts.table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${pkColumns.join(", ")}) DO UPDATE SET ${setClauses}`;

    try {
      const stmt = this.db.prepare(sql);
      const insertMany = this.db.transaction((records: T[]) => {
        for (const record of records) {
          stmt.run(record as Record<string, unknown>);
          this.markSearchDirty(opts.table, record as Record<string, unknown>);
        }
      });
      insertMany(opts.records);
      this.maybeReanalyze();
    } catch (error) {
      logger.error(`[SQLiteTelemetryAdapter] MergeInsert into ${opts.table} failed`, error);
      throw error;
    }
  }

  private markSearchDirty(table: string, record: Record<string, unknown>): void {
    if (table !== "traces" && table !== "observations") return;
    if (!isSessionSearchAvailable(this.db)) return;
    const projectId = record.project_id;
    const id = record.id;
    if (typeof projectId !== "string" || typeof id !== "string") return;
    const raw = record.updated_at ?? record.event_ts ?? record.created_at;
    const eventTime = record.start_time ?? record.timestamp ?? record.event_ts;
    const revision = typeof raw === "number" ? raw : Date.parse(String(raw ?? "")) || Date.now();
    try {
      new SessionSearchStorage(this.db).markDirty({
        projectId,
        id,
        revision,
        kind: table === "traces" ? "trace" : "observation",
        eventTime: typeof eventTime === "string" ? eventTime : undefined,
      });
    } catch (error) {
      // Dirty marking is part of the write contract: swallowing this would make
      // a successful telemetry update permanently invisible to search.
      logger.error(`[SQLiteTelemetryAdapter] Failed to mark ${table} source dirty`, error);
      throw error;
    }
  }

  /**
   * List dataset run items for a project, optionally scoped to one run.
   * Read-only: routed through the worker pool when available (SELECT).
   */
  async queryDatasetRunItems(
    projectId: string,
    datasetRunId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (datasetRunId) {
      return this.query({
        query: `SELECT * FROM dataset_run_items WHERE project_id = @projectId AND dataset_run_id = @datasetRunId AND is_deleted = 0 ORDER BY created_at ASC`,
        params: { projectId, datasetRunId },
      });
    }
    return this.query({
      query: `SELECT * FROM dataset_run_items WHERE project_id = @projectId AND is_deleted = 0 ORDER BY created_at ASC`,
      params: { projectId },
    });
  }

  async *queryStream<T = Record<string, unknown>>(opts: TelemetryQueryOpts): AsyncGenerator<T> {
    // SQLite doesn't support true streaming, but we can iterate rows
    const rows = await this.query<T>(opts);
    for (const row of rows) {
      yield row;
    }
  }

  /** Queue occupancy and worker lifecycle for process diagnostics. */
  getReadPoolStats() {
    return this.readPool?.stats() ?? null;
  }

  /** Main connection for the bounded session-search lifecycle worker. */
  getDatabase(): Database.Database {
    return this.db;
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.readPool?.close();
    this.db.close();
  }
}
