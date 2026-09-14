import type Database from "better-sqlite3";

export function initializeTelemetrySchema(db: Database.Database): void {
  db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_scores_project_ts
        ON scores(project_id, timestamp DESC, id DESC);

      -- Dataset run items (written by the dataset-run-item-create ingestion
      -- event; mirrors upstream ClickHouse dataset_run_items_rmt). The dataset
      -- run metadata itself lives in the metadata DB (dataset_runs) — this
      -- table only links runs to traces/items in the telemetry DB.
      CREATE TABLE IF NOT EXISTS dataset_run_items (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        dataset_run_id TEXT NOT NULL,
        dataset_item_id TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        observation_id TEXT,
        error TEXT,
        dataset_item_valid_from TEXT,
        dataset_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_ts TEXT NOT NULL DEFAULT (datetime('now')),
        is_deleted INTEGER DEFAULT 0,
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

      CREATE INDEX IF NOT EXISTS idx_dri_project_run
        ON dataset_run_items(project_id, dataset_run_id);
      CREATE INDEX IF NOT EXISTS idx_dri_project_item
        ON dataset_run_items(project_id, dataset_item_id);
      CREATE INDEX IF NOT EXISTS idx_dri_project_trace
        ON dataset_run_items(project_id, trace_id);

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
      -- Covers the error investigation feed and signature analysis. Level is
      -- before time so ERROR-only windows do not scan every observation.
      CREATE INDEX IF NOT EXISTS idx_obs_error_start
        ON observations(project_id, is_deleted, level, start_time DESC, id DESC);
      -- Public observations pagination filters type + level together. Keep both
      -- before time so pages seek directly to matching rows and exact counts
      -- stay in the index instead of reading every ERROR row to check its type.
      CREATE INDEX IF NOT EXISTS idx_obs_type_level_start
        ON observations(project_id, is_deleted, type, level, start_time DESC);
      -- Covers sessions list: GROUP BY session_id with timestamp/user aggregation
      CREATE INDEX IF NOT EXISTS idx_traces_deleted_session
        ON traces(project_id, is_deleted, session_id, timestamp, user_id, environment, tags);
      -- Covers users list: GROUP BY user_id with timestamp aggregation
      CREATE INDEX IF NOT EXISTS idx_traces_deleted_user
        ON traces(project_id, is_deleted, user_id, timestamp, environment);
    `);
}
