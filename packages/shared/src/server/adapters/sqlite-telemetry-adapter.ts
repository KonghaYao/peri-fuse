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
import type { TelemetryDBAdapter, TelemetryInsertOpts, TelemetryQueryOpts } from "./types";

const DEFAULT_DB_PATH = ".langfuse/telemetry.db";

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

  constructor(dbPath?: string) {
    const rawPath = dbPath ?? process.env.LANGFUSE_SQLITE_DB_PATH ?? DEFAULT_DB_PATH;
    // Resolve relative paths from the monorepo root so the DB location is
    // consistent regardless of which package's CWD starts the process.
    const resolvedPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(findMonorepoRoot(), rawPath);

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
    `);
  }

  async query<T = Record<string, unknown>>(opts: TelemetryQueryOpts): Promise<T[]> {
    try {
      const stmt = this.db.prepare(opts.query);
      const rows = stmt.all(opts.params ?? {}) as T[];
      return rows;
    } catch (error) {
      logger.error(`[SQLiteTelemetryAdapter] Query failed: ${opts.query}`, error);
      throw error;
    }
  }

  async command(opts: TelemetryQueryOpts): Promise<void> {
    try {
      const stmt = this.db.prepare(opts.query);
      stmt.run(opts.params ?? {});
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
    this.db.close();
  }
}
