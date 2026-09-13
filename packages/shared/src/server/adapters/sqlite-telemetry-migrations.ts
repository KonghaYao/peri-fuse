import type Database from "better-sqlite3";
import { logger } from "../logger";
import {
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "./trace-metrics-sql";

export class TelemetrySchemaMigrations {
  constructor(private readonly db: Database.Database) {}
  /**
   * Idempotent schema migrations for databases created before a column was
   * added. Uses PRAGMA table_info to check existence before ALTER TABLE.
   */
  migrate(): void {
    this.ensureColumn("trace_metrics", "cached_tokens", "INTEGER DEFAULT 0");
    this.ensureColumn("trace_metrics", "cache_creation_tokens", "INTEGER DEFAULT 0");
    this.ensureColumn("trace_metrics", "gross_input_tokens", "INTEGER DEFAULT 0");

    // v5: v2/v3 scores API support — scores gained a JSON metadata column and
    // a session_id column (session-level scores) after the table shipped.
    // ensureColumn is idempotent (PRAGMA table_info check), so this is safe to
    // run on every startup for databases created before the columns existed.
    this.ensureColumn("scores", "metadata", "TEXT DEFAULT '{}'");
    this.ensureColumn("scores", "session_id", "TEXT");
    // v6: session-level scores — trace_id must be nullable. SQLite cannot drop
    // a NOT NULL constraint via ALTER TABLE, so rebuild the table when the
    // legacy constraint is detected (runs before any writes; indexes are
    // recreated afterwards).
    this.ensureScoresTraceIdNullable();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_scores_project_ts
        ON scores(project_id, timestamp DESC, id DESC)`,
    );

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
   * v6 migration: session-level scores require a nullable scores.trace_id.
   * Databases created before this change declare `trace_id TEXT NOT NULL`,
   * which rejects session scores (no trace). SQLite cannot ALTER a column
   * constraint, so the table is rebuilt (data copied, indexes recreated).
   * Runs on every startup; the PRAGMA notnull check makes it a no-op for
   * databases that already have the nullable column.
   */
  private ensureScoresTraceIdNullable(): void {
    const cols = this.db.prepare(`PRAGMA table_info(scores)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const traceId = cols.find((c) => c.name === "trace_id");
    if (traceId?.notnull !== 1) return;

    const columns = [
      "id",
      "project_id",
      "trace_id",
      "observation_id",
      "name",
      "value",
      "string_value",
      "source",
      "comment",
      "author_user_id",
      "config_id",
      "data_type",
      "timestamp",
      "created_at",
      "updated_at",
      "event_ts",
      "is_deleted",
      "environment",
      "queue_id",
      "metadata",
      "session_id",
    ].join(", ");
    this.db.exec(`
      CREATE TABLE scores_new (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        trace_id TEXT,
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
        metadata TEXT DEFAULT '{}',
        session_id TEXT,
        PRIMARY KEY (project_id, id)
      );
      INSERT INTO scores_new (${columns})
        SELECT ${columns} FROM scores;
      DROP TABLE scores;
      ALTER TABLE scores_new RENAME TO scores;
      CREATE INDEX IF NOT EXISTS idx_scores_project_ts
        ON scores(project_id, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_scores_project_trace
        ON scores(project_id, trace_id);
      CREATE INDEX IF NOT EXISTS idx_scores_project_name
        ON scores(project_id, name);
    `);
    logger.info("[SQLiteTelemetryAdapter] Rebuilt scores table (trace_id now nullable)");
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
}
