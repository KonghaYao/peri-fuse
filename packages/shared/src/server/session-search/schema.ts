import type { LocalExecutor } from "../../db/local";

export const SESSION_SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_texts (
  text_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  chunk_no INTEGER NOT NULL, display_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
  project_scope TEXT NOT NULL, index_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, content_hash, chunk_no, index_version)
);
CREATE TABLE IF NOT EXISTS search_trigrams (
  project_id TEXT NOT NULL, gram TEXT NOT NULL, text_id INTEGER NOT NULL,
  PRIMARY KEY(project_id, gram, text_id)
);
CREATE INDEX IF NOT EXISTS idx_search_trigrams_text ON search_trigrams(project_id,text_id);
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
  revision INTEGER NOT NULL, PRIMARY KEY(project_id,source_kind,source_id)
);
CREATE TABLE IF NOT EXISTS search_index_state (
  project_id TEXT PRIMARY KEY, index_version INTEGER NOT NULL DEFAULT 1,
  coverage TEXT NOT NULL DEFAULT 'new', pending INTEGER NOT NULL DEFAULT 0,
  trace_cursor INTEGER NOT NULL DEFAULT 0, observation_cursor INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export async function initializeSessionSearchSchema(db: LocalExecutor): Promise<void> {
  await db.exec(SESSION_SEARCH_SCHEMA_SQL);
}

export async function isSessionSearchAvailable(db: LocalExecutor): Promise<boolean> {
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('search_dirty','search_source_revisions','search_index_state','search_texts','search_occurrences','search_trigrams')",
  );
  return tables.length === 6;
}

export function searchTrigrams(text: string): string[] {
  const characters = Array.from(text);
  return [
    ...new Set(
      characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join("")),
    ),
  ];
}
