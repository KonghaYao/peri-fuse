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
import { isReadOnlySql, resolveReadPoolSize, SqliteReadPool } from "./sqlite-read-pool";
import type { TelemetryDBAdapter, TelemetryInsertOpts, TelemetryQueryOpts } from "./types";

const DEFAULT_DB_PATH = ".langfuse/telemetry.db";

/**
 * SQL fragments (json_extract over `o.usage_details`) computing the cache token
 * columns of the materialized `trace_metrics` table. Shared by the ingestion-
 * time maintenance (processEventBatchLite) and the one-time backfill migration
 * below. Both queries alias `observations` as `o`.
 *
 * Cache key naming varies by ingestion path: the OTLP processor normalizes to
 * `input_cached_tokens` / `input_cache_creation*`, while the plain SDK path
 * stores the provider's raw keys — Anthropic's `cache_read_input_tokens` /
 * `cache_creation_input_tokens` and OpenAI's `cached_tokens`. A single
 * usage_details object only ever carries ONE naming scheme, so summing across
 * all known keys never double-counts.
 *
 * Each metric has a per-row expression (`*_ROW_SQL`, no aggregate) and an
 * aggregated expression (`SUM(...)`). The per-row forms are needed to build the
 * gross-input CASE below without nesting aggregates.
 */
const CACHED_TOKENS_ROW_SQL = `(
             COALESCE(json_extract(o.usage_details, '$.input_cached_tokens'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_read'), 0) +
             COALESCE(json_extract(o.usage_details, '$.cache_read_input_tokens'), 0) +
             COALESCE(json_extract(o.usage_details, '$.cached_tokens'), 0))`;

const CACHE_CREATION_TOKENS_ROW_SQL = `(
             COALESCE(json_extract(o.usage_details, '$.input_cache_creation'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_write'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_creation_5m'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_creation_1h'), 0) +
             COALESCE(json_extract(o.usage_details, '$.cache_creation_input_tokens'), 0))`;

export const TRACE_METRICS_CACHED_TOKENS_SQL = `COALESCE(SUM(${CACHED_TOKENS_ROW_SQL}), 0)`;

export const TRACE_METRICS_CACHE_CREATION_TOKENS_SQL = `COALESCE(SUM(${CACHE_CREATION_TOKENS_ROW_SQL}), 0)`;

/**
 * Per-observation GROSS input tokens (the full prompt/context size, cache
 * included) — the correct denominator for cache-hit-rate.
 *
 * Providers disagree on what `usage_details.input` means:
 *  - Anthropic (and gateways forwarding it verbatim) report `input` as GROSS,
 *    already including cache reads (`input` = net + cache_read + creation);
 *  - OpenAI / the OTLP-normalized path report `input` as NET (cache excluded).
 * Heuristic: if `input` already covers the cache tokens (input >= cache read +
 * creation) it is gross, use it as-is; otherwise it is net, so add the cache
 * tokens back. When there is no cache the two agree, so this is always safe.
 */
export const TRACE_METRICS_GROSS_INPUT_TOKENS_SQL = `COALESCE(SUM(
             CASE WHEN COALESCE(json_extract(o.usage_details, '$.input'), 0) >=
                       (${CACHED_TOKENS_ROW_SQL} + ${CACHE_CREATION_TOKENS_ROW_SQL})
                  THEN COALESCE(json_extract(o.usage_details, '$.input'), 0)
                  ELSE COALESCE(json_extract(o.usage_details, '$.input'), 0) +
                       ${CACHED_TOKENS_ROW_SQL} + ${CACHE_CREATION_TOKENS_ROW_SQL}
             END), 0)`;

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
    this.initializeSchema();
    this.migrateSchema();

    logger.info(`[SQLiteTelemetryAdapter] Database opened at ${resolvedPath}`);
  }

  private initializeSchema(): void {
    this.db.exec(`
      -- Core telemetry tables (simplified schema matching ClickHouse structure)
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        name TEXT,
        user_id TEXT,
        metadata TEXT DEFAULT '{}',
        release TEXT,
        version TEXT,
        public INTEGER DEFAULT 0,
        bookmarked INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        input TEXT,
        output TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_ts TEXT NOT NULL DEFAULT (datetime('now')),
        is_deleted INTEGER DEFAULT 0,
        environment TEXT DEFAULT 'default',
        PRIMARY KEY (project_id, id)
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        trace_id TEXT,
        parent_observation_id TEXT,
        type TEXT NOT NULL DEFAULT 'SPAN',
        name TEXT,
        start_time TEXT NOT NULL DEFAULT (datetime('now')),
        end_time TEXT,
        metadata TEXT DEFAULT '{}',
        model TEXT,
        input TEXT,
        output TEXT,
        level TEXT DEFAULT 'DEFAULT',
        status_message TEXT,
        completion_start_time TEXT,
        prompt_id TEXT,
        prompt_name TEXT,
        prompt_version INTEGER,
        model_parameters TEXT DEFAULT '{}',
        usage_details TEXT DEFAULT '{}',
        cost_details TEXT DEFAULT '{}',
        provided_usage_details TEXT DEFAULT '{}',
        provided_cost_details TEXT DEFAULT '{}',
        total_cost REAL,
        version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_ts TEXT NOT NULL DEFAULT (datetime('now')),
        is_deleted INTEGER DEFAULT 0,
        environment TEXT DEFAULT 'default',
        PRIMARY KEY (project_id, id)
      );

      -- Materialized per-trace observation metrics (avoids full-table GROUP BY)
      CREATE TABLE IF NOT EXISTS trace_metrics (
        project_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        obs_count INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        input_cost REAL DEFAULT 0,
        output_cost REAL DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        timestamp TEXT,
        PRIMARY KEY (project_id, trace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trace_metrics_session
        ON trace_metrics(project_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_trace_metrics_user
        ON trace_metrics(project_id, user_id);
      -- idx_trace_metrics_ts is created by the v4 migration: on legacy
      -- databases the timestamp column does not exist yet at this point.

      -- Materialized per-day dashboard rollups (maintained by stats/daily-stats)
      CREATE TABLE IF NOT EXISTS daily_stats (
        project_id TEXT NOT NULL,
        day TEXT NOT NULL,
        traces INTEGER NOT NULL DEFAULT 0,
        users_json TEXT NOT NULL DEFAULT '[]',
        observations INTEGER NOT NULL DEFAULT 0,
        generations INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        warnings INTEGER NOT NULL DEFAULT 0,
        debugs INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        gross_input_tokens INTEGER NOT NULL DEFAULT 0,
        scores_count INTEGER NOT NULL DEFAULT 0,
        scores_val_count INTEGER NOT NULL DEFAULT 0,
        score_sum REAL NOT NULL DEFAULT 0,
        lat_count INTEGER NOT NULL DEFAULT 0,
        lat_sum_ms REAL NOT NULL DEFAULT 0,
        lat_hist TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, day)
      );
      CREATE TABLE IF NOT EXISTS daily_model_stats (
        project_id TEXT NOT NULL,
        day TEXT NOT NULL,
        model TEXT NOT NULL,
        observations INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        lat_count INTEGER NOT NULL DEFAULT 0,
        lat_sum_ms REAL NOT NULL DEFAULT 0,
        lat_hist TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (project_id, day, model)
      );

      CREATE TABLE IF NOT EXISTS scores (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        observation_id TEXT,
        name TEXT NOT NULL,
        value REAL,
        string_value TEXT,
        source TEXT NOT NULL DEFAULT 'API',
        comment TEXT,
        author_user_id TEXT,
        config_id TEXT,
        data_type TEXT NOT NULL DEFAULT 'NUMERIC',
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_ts TEXT NOT NULL DEFAULT (datetime('now')),
        is_deleted INTEGER DEFAULT 0,
        environment TEXT DEFAULT 'default',
        queue_id TEXT,
        PRIMARY KEY (project_id, id)
      );

      -- Indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_traces_project_timestamp
        ON traces(project_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_traces_project_session
        ON traces(project_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_traces_project_name
        ON traces(project_id, name);

      CREATE INDEX IF NOT EXISTS idx_observations_project_trace
        ON observations(project_id, trace_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project_start
        ON observations(project_id, start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_project_type
        ON observations(project_id, type);

      CREATE INDEX IF NOT EXISTS idx_scores_project_trace
        ON scores(project_id, trace_id);
      CREATE INDEX IF NOT EXISTS idx_scores_project_name
        ON scores(project_id, name);

      -- Performance indexes for aggregation-heavy queries (sessions/users/dashboard)
      -- Covers observations list filtering by name
      CREATE INDEX IF NOT EXISTS idx_obs_deleted_name
        ON observations(project_id, is_deleted, name);
      -- Covers dashboard daily observations (time-bounded COUNT + SUM)
      CREATE INDEX IF NOT EXISTS idx_obs_start_cost
        ON observations(project_id, is_deleted, start_time, total_cost);
      -- Covers dashboard model breakdown (type + time filter)
      CREATE INDEX IF NOT EXISTS idx_obs_type_start_model
        ON observations(project_id, is_deleted, type, start_time, model, total_cost);
      -- Covers dashboard level mix (time-bounded GROUP BY level)
      CREATE INDEX IF NOT EXISTS idx_obs_start_level
        ON observations(project_id, is_deleted, start_time, level);
      -- Covers sessions list: GROUP BY session_id with timestamp/user aggregation
      CREATE INDEX IF NOT EXISTS idx_traces_deleted_session
        ON traces(project_id, is_deleted, session_id, timestamp, user_id, environment, tags);
      -- Covers users list: GROUP BY user_id with timestamp aggregation
      CREATE INDEX IF NOT EXISTS idx_traces_deleted_user
        ON traces(project_id, is_deleted, user_id, timestamp, environment);
    `);
  }

  /**
   * Idempotent schema migrations for databases created before a column was
   * added. Uses PRAGMA table_info to check existence before ALTER TABLE.
   */
  private migrateSchema(): void {
    this.ensureColumn("trace_metrics", "cached_tokens", "INTEGER DEFAULT 0");
    this.ensureColumn("trace_metrics", "cache_creation_tokens", "INTEGER DEFAULT 0");
    this.ensureColumn("trace_metrics", "gross_input_tokens", "INTEGER DEFAULT 0");

    // One-time backfill of cache token columns for existing rows (guarded by
    // PRAGMA user_version so it only runs once per database file).
    const version = Number(this.db.pragma("user_version", { simple: true }) ?? 0);
    if (version < 1) {
      this.backfillTraceMetricsCache();
      this.db.pragma("user_version = 1");
    }
    // v2: the cache SQL originally only matched the OTLP-normalized keys
    // (input_cached_tokens / input_cache_creation*), missing the raw provider
    // keys written by the plain SDK path (cache_read_input_tokens etc.), so
    // existing rows were backfilled with 0. Re-run the backfill with the
    // corrected SQL to fix them.
    if (version < 2) {
      this.backfillTraceMetricsCache();
      this.db.pragma("user_version = 2");
    }
    // v3: add gross_input_tokens and fix the cache-hit-rate denominator. The
    // old formula (input + cached + creation) double-counted cache for
    // providers that report `input` as gross (Anthropic), halving the hit rate.
    if (version < 3) {
      this.backfillTraceMetricsCache();
      this.db.pragma("user_version = 3");
    }
    // v4: give trace_metrics a timestamp column so time-windowed aggregates
    // (dashboard summary / top users) no longer need to JOIN traces, and make
    // sure the daily_stats rollup tables exist. Row backfill of daily_stats
    // itself happens asynchronously in the stats maintenance job.
    if (version < 4) {
      this.ensureColumn("trace_metrics", "timestamp", "TEXT");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trace_metrics_ts
          ON trace_metrics(project_id, timestamp);
        UPDATE trace_metrics SET timestamp = (
          SELECT t.timestamp FROM traces t
          WHERE t.project_id = trace_metrics.project_id AND t.id = trace_metrics.trace_id
        ) WHERE timestamp IS NULL;
        CREATE TABLE IF NOT EXISTS daily_stats (
          project_id TEXT NOT NULL,
          day TEXT NOT NULL,
          traces INTEGER NOT NULL DEFAULT 0,
          users_json TEXT NOT NULL DEFAULT '[]',
          observations INTEGER NOT NULL DEFAULT 0,
          generations INTEGER NOT NULL DEFAULT 0,
          errors INTEGER NOT NULL DEFAULT 0,
          warnings INTEGER NOT NULL DEFAULT 0,
          debugs INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          gross_input_tokens INTEGER NOT NULL DEFAULT 0,
          scores_count INTEGER NOT NULL DEFAULT 0,
          scores_val_count INTEGER NOT NULL DEFAULT 0,
          score_sum REAL NOT NULL DEFAULT 0,
          lat_count INTEGER NOT NULL DEFAULT 0,
          lat_sum_ms REAL NOT NULL DEFAULT 0,
          lat_hist TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, day)
        );
        CREATE TABLE IF NOT EXISTS daily_model_stats (
          project_id TEXT NOT NULL,
          day TEXT NOT NULL,
          model TEXT NOT NULL,
          observations INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0,
          lat_count INTEGER NOT NULL DEFAULT 0,
          lat_sum_ms REAL NOT NULL DEFAULT 0,
          lat_hist TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY (project_id, day, model)
        );
      `);
      this.db.pragma("user_version = 4");
      logger.info("[SQLiteTelemetryAdapter] Migrated telemetry schema to v4");
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      logger.info(`[SQLiteTelemetryAdapter] Added column ${table}.${column}`);
    }
  }

  /**
   * Recompute all trace_metrics rows (same SQL as ingestion-time maintenance,
   * without the trace_id filter) so pre-existing databases get cache columns
   * populated. Runs once, guarded by user_version.
   */
  private backfillTraceMetricsCache(): void {
    this.db.exec(`
      INSERT OR REPLACE INTO trace_metrics (project_id, trace_id, user_id, session_id, obs_count, total_cost, input_cost, output_cost, input_tokens, output_tokens, total_tokens, cached_tokens, cache_creation_tokens, gross_input_tokens, timestamp)
      SELECT o.project_id, o.trace_id, t.user_id, t.session_id,
             COUNT(*),
             COALESCE(SUM(o.total_cost), 0),
             COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.input'), 0)), 0),
             COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.output'), 0)), 0),
             COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.input'), 0)), 0),
             COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.output'), 0)), 0),
             COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.total'),
                 COALESCE(json_extract(o.usage_details, '$.input'), 0) +
                 COALESCE(json_extract(o.usage_details, '$.output'), 0))), 0),
             ${TRACE_METRICS_CACHED_TOKENS_SQL},
             ${TRACE_METRICS_CACHE_CREATION_TOKENS_SQL},
             ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL},
             t.timestamp
      FROM observations o
      LEFT JOIN traces t ON t.project_id = o.project_id AND t.id = o.trace_id
      WHERE o.is_deleted = 0
      GROUP BY o.project_id, o.trace_id
    `);
    logger.info("[SQLiteTelemetryAdapter] Backfilled trace_metrics cache columns");
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
    // Offload pure reads to worker threads so heavy aggregates never block the
    // event loop; WAL permits these read-only connections alongside writes.
    if (isReadOnlySql(opts.query)) {
      const pool = this.getReadPool();
      if (pool) {
        try {
          return await pool.query<T>(opts.query, (opts.params ?? {}) as Record<string, unknown>);
        } catch (error) {
          logger.error(`[SQLiteTelemetryAdapter] Query failed: ${opts.query}`, error);
          throw error;
        }
      }
    }
    try {
      const stmt = this.db.prepare(opts.query);
      const rows = stmt.all(opts.params ?? {}) as T[];
      return rows;
    } catch (error) {
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
        }
      });
      insertMany(opts.records);
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
      opts.table === "traces" || opts.table === "observations" || opts.table === "scores"
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
        }
      });
      insertMany(opts.records);
    } catch (error) {
      logger.error(`[SQLiteTelemetryAdapter] MergeInsert into ${opts.table} failed`, error);
      throw error;
    }
  }

  async *queryStream<T = Record<string, unknown>>(opts: TelemetryQueryOpts): AsyncGenerator<T> {
    // SQLite doesn't support true streaming, but we can iterate rows
    const rows = await this.query<T>(opts);
    for (const row of rows) {
      yield row;
    }
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
    this.readPool?.close();
    this.db.close();
  }
}
