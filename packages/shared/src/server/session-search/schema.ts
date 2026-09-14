import type Database from "better-sqlite3";

const available = new WeakSet<Database.Database>();
export function isSessionSearchAvailable(db: Database.Database): boolean {
  if (available.has(db)) return true;
  const tables = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('search_dirty','search_source_revisions','search_index_state','search_texts','search_occurrences','search_fts')",
    )
    .all() as Array<{ name: string; sql: string | null }>;
  const ok =
    tables.length === 6 &&
    tables.some(
      (table) => table.name === "search_fts" && /CREATE VIRTUAL TABLE/i.test(table.sql ?? ""),
    );
  if (ok) available.add(db);
  return ok;
}

/** Tables are kept in telemetry.db so indexing shares the telemetry backup and WAL. */
export function initializeSessionSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_texts (
      text_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL, content_hash TEXT NOT NULL, chunk_no INTEGER NOT NULL,
      display_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
      project_scope TEXT NOT NULL, index_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(project_id, content_hash, chunk_no, index_version)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      normalized_text, project_scope, content='search_texts', content_rowid='text_id', tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS search_occurrences (
      occurrence_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text_id INTEGER NOT NULL,
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, trace_id TEXT, role TEXT NOT NULL,
      field TEXT NOT NULL, message_order INTEGER NOT NULL, chunk_no INTEGER NOT NULL,
      source_version INTEGER NOT NULL, event_time TEXT NOT NULL, session_id TEXT,
      display_start INTEGER NOT NULL DEFAULT 0, display_end INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_search_occ_window ON search_occurrences(project_id,event_time DESC,occurrence_id,text_id);
    CREATE INDEX IF NOT EXISTS idx_search_occ_source ON search_occurrences(project_id,source_kind,source_id);
    CREATE INDEX IF NOT EXISTS idx_search_occ_text ON search_occurrences(project_id,text_id);
    CREATE INDEX IF NOT EXISTS idx_search_occ_context ON search_occurrences(project_id,source_kind,source_id,source_version,message_order,chunk_no);
    CREATE TABLE IF NOT EXISTS search_dirty (
      project_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      revision INTEGER NOT NULL, event_time TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT, last_error TEXT, PRIMARY KEY(project_id,source_kind,source_id)
    );
    CREATE TABLE IF NOT EXISTS search_source_revisions (
      project_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      revision INTEGER NOT NULL, PRIMARY KEY(project_id, source_kind, source_id)
    );
    CREATE TABLE IF NOT EXISTS search_index_state (
      project_id TEXT PRIMARY KEY, index_version INTEGER NOT NULL DEFAULT 1,
      coverage TEXT NOT NULL DEFAULT 'new', pending INTEGER NOT NULL DEFAULT 0,
      trace_cursor INTEGER NOT NULL DEFAULT 0, observation_cursor INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TRIGGER IF NOT EXISTS search_dirty_pending_insert AFTER INSERT ON search_dirty BEGIN
      INSERT INTO search_index_state(project_id,coverage,pending,updated_at) VALUES(new.project_id,'new',1,datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET pending=search_index_state.pending+1,updated_at=datetime('now');
    END;
    CREATE TRIGGER IF NOT EXISTS search_dirty_pending_delete AFTER DELETE ON search_dirty BEGIN
      UPDATE search_index_state SET pending=MAX(0,pending-1),updated_at=datetime('now') WHERE project_id=old.project_id;
    END;
    CREATE TRIGGER IF NOT EXISTS search_trace_delete_dirty AFTER DELETE ON traces BEGIN
      INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(old.project_id,'trace',old.id,1)
      ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=revision+1;
      INSERT INTO search_dirty(project_id,source_kind,source_id,revision,event_time,next_attempt_at)
        SELECT old.project_id,'trace',old.id,revision,old.timestamp,datetime('now') FROM search_source_revisions
        WHERE project_id=old.project_id AND source_kind='trace' AND source_id=old.id
        ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=excluded.revision,event_time=excluded.event_time,next_attempt_at=datetime('now');
    END;
    CREATE TRIGGER IF NOT EXISTS search_observation_delete_dirty AFTER DELETE ON observations BEGIN
      INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(old.project_id,'observation',old.id,1)
      ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=revision+1;
      INSERT INTO search_dirty(project_id,source_kind,source_id,revision,event_time,next_attempt_at)
        SELECT old.project_id,'observation',old.id,revision,old.start_time,datetime('now') FROM search_source_revisions
        WHERE project_id=old.project_id AND source_kind='observation' AND source_id=old.id
        ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=excluded.revision,event_time=excluded.event_time,next_attempt_at=datetime('now');
    END;
  `);
  try {
    db.exec("ALTER TABLE search_dirty ADD COLUMN event_time TEXT");
  } catch {
    /* existing schema already has it */
  }
  // Mark only a complete, genuine FTS schema as available. CREATE IF NOT
  // EXISTS can leave a pre-existing incompatible table in place.
  isSessionSearchAvailable(db);
}
