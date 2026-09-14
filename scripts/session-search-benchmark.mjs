import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const Database = createRequire(import.meta.url)("../packages/shared/node_modules/better-sqlite3");

const project = "benchmark-project";
const scope = "benchmark-scope";
const now = Date.now();
const recentFrom = new Date(now - 60 * 60 * 1000).toISOString();
const to = new Date(now + 1).toISOString();
const oldTime = new Date(now - 24 * 60 * 60 * 1000).toISOString();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "peri-session-search-bench-"));
const dbPath = path.join(root, "telemetry.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE traces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    user_id TEXT, timestamp TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE observations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, trace_id TEXT NOT NULL,
    start_time TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE search_texts (
    text_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    chunk_no INTEGER NOT NULL, display_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
    project_scope TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE search_fts USING fts5(
    normalized_text, project_scope, content='search_texts', content_rowid='text_id', tokenize='trigram'
  );
  CREATE TABLE search_occurrences (
    occurrence_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text_id INTEGER NOT NULL,
    source_kind TEXT NOT NULL, source_id TEXT NOT NULL, trace_id TEXT, role TEXT NOT NULL,
    field TEXT NOT NULL, message_order INTEGER NOT NULL, chunk_no INTEGER NOT NULL,
    source_version INTEGER NOT NULL, event_time TEXT NOT NULL
  );
  CREATE TABLE search_source_revisions (
    project_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
    revision INTEGER NOT NULL, PRIMARY KEY(project_id, source_kind, source_id)
  );
  CREATE TABLE search_index_state (
    project_id TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 0,
    coverage TEXT NOT NULL DEFAULT 'ready', last_error TEXT
  );
  CREATE INDEX idx_search_occ_window ON search_occurrences(project_id,event_time DESC,occurrence_id,text_id);
  CREATE INDEX idx_search_occ_text ON search_occurrences(project_id,text_id);
  CREATE INDEX idx_traces_project_timestamp ON traces(project_id,timestamp DESC);
  CREATE INDEX idx_observations_project_start ON observations(project_id,start_time DESC);
`);

const insertTrace = db.prepare("INSERT INTO traces VALUES (?, ?, ?, ?, ?, 0)");
const insertText = db.prepare(
  "INSERT INTO search_texts(project_id,content_hash,chunk_no,display_text,normalized_text,project_scope) VALUES(?,?,?,?,?,?)",
);
const insertFts = db.prepare(
  "INSERT INTO search_fts(rowid,normalized_text,project_scope) VALUES(?,?,?)",
);
const insertOcc = db.prepare("INSERT INTO search_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
const insertRev = db.prepare("INSERT INTO search_source_revisions VALUES(?,?,?,?)");

function build(size) {
  const reset = db.transaction(() => {
    db.exec(
      "INSERT INTO search_fts(search_fts) VALUES('delete-all'); DELETE FROM search_occurrences; DELETE FROM search_texts; DELETE FROM search_source_revisions; DELETE FROM search_index_state; DELETE FROM traces;",
    );
    const common = "commonphrase";
    for (let i = 0; i < size; i++) {
      const recent = i >= size - 100;
      const id = `trace-${i}`;
      const event = recent
        ? new Date(now - (100 - (i - (size - 100))) * 1000).toISOString()
        : oldTime;
      const unique = i === Math.floor(size / 2) ? "rareneedle" : "ordinary";
      const text = `${common} ${unique} message-${i}`;
      insertTrace.run(id, project, `session-${i}`, `user-${i}`, event);
      const textInfo = insertText.run(project, `hash-${size}-${i}`, 0, text, text, scope);
      insertFts.run(Number(textInfo.lastInsertRowid), text, scope);
      insertOcc.run(
        `${id}-occ`,
        project,
        Number(textInfo.lastInsertRowid),
        "trace",
        id,
        id,
        "user",
        "input.messages",
        0,
        0,
        1,
        event,
      );
      insertRev.run(project, "trace", id, 1);
    }
    insertText.run(
      project,
      `hash-${size}-recent-extra`,
      0,
      "recent-only commonphrase",
      "recent-only commonphrase",
      scope,
    );
    db.prepare(
      "INSERT INTO search_index_state(project_id,pending,coverage) VALUES(?,0,'ready')",
    ).run(project);
  });
  reset();
  db.exec("ANALYZE");
}

const sql = (shortWindow) => `WITH time_candidates AS MATERIALIZED (
  SELECT * FROM search_occurrences INDEXED BY idx_search_occ_window
  WHERE project_id=@projectId AND event_time >= @from AND event_time < @to
)
SELECT o.occurrence_id, o.source_version, o.source_kind, o.source_id, o.trace_id, o.role,
  o.field, o.message_order, o.chunk_no, o.event_time AS record_time, o.text_id,
  CASE WHEN o.source_kind='trace' THEN tr.session_id ELSE tr2.session_id END AS session_id,
  CASE WHEN o.source_kind='trace' THEN tr.user_id ELSE tr2.user_id END AS user_id
FROM time_candidates o
JOIN search_texts t ON t.text_id=o.text_id AND t.project_id=@projectId
${shortWindow ? "" : "JOIN search_fts f ON f.rowid=t.text_id"}
LEFT JOIN observations ob ON o.source_kind='observation' AND ob.project_id=o.project_id AND ob.id=o.source_id AND ob.is_deleted=0
LEFT JOIN traces tr ON o.source_kind='trace' AND tr.project_id=o.project_id AND tr.id=o.source_id AND tr.is_deleted=0
LEFT JOIN traces tr2 ON o.source_kind='observation' AND tr2.project_id=o.project_id AND tr2.id=o.trace_id AND tr2.is_deleted=0
JOIN search_source_revisions sr ON sr.project_id=o.project_id AND sr.source_kind=o.source_kind AND sr.source_id=o.source_id AND sr.revision=o.source_version
  WHERE t.project_id=@projectId AND ${shortWindow ? "instr(t.normalized_text,@literal)>0" : "f.normalized_text MATCH @match AND f.project_scope MATCH @scope"}
  AND ((o.source_kind='trace' AND tr.id IS NOT NULL) OR (o.source_kind='observation' AND ob.id IS NOT NULL AND tr2.id IS NOT NULL))
ORDER BY o.event_time DESC, o.occurrence_id DESC LIMIT @cap`;

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}
function runQuery(term, from) {
  const shortWindow = from === recentFrom;
  const stmt = db.prepare(sql(shortWindow));
  const values = [];
  let count = 0;
  for (let i = 0; i < 20; i++) {
    const start = process.hrtime.bigint();
    const rows = stmt.all({
      projectId: project,
      match: `"${term}"`,
      literal: term,
      scope: `"${scope}"`,
      from,
      to,
      cap: 1001,
    });
    values.push(Number(process.hrtime.bigint() - start) / 1e6);
    count = rows.length;
  }
  return {
    term,
    window: from === recentFrom ? "1h" : "all-history",
    rows: count,
    ...stats(values),
  };
}

const results = [];
for (const size of [10_000, 100_000]) {
  build(size);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql(true)}`).all({
    projectId: project,
    match: '"commonphrase"',
    literal: "commonphrase",
    scope: `"${scope}"`,
    from: recentFrom,
    to,
    cap: 1001,
  });
  results.push({
    size,
    plan,
    samples: [
      runQuery("commonphrase", recentFrom),
      runQuery("commonphrase", new Date(0).toISOString()),
      runQuery("rareneedle", recentFrom),
      runQuery("rareneedle", new Date(0).toISOString()),
      runQuery("missingterm", recentFrom),
      runQuery("missingterm", new Date(0).toISOString()),
    ],
  });
}
console.log(
  JSON.stringify(
    {
      dbPath,
      sqlite: db.prepare("select sqlite_version() as version").get(),
      node: process.version,
      results,
    },
    null,
    2,
  ),
);
db.close();
fs.rmSync(root, { recursive: true, force: true });
