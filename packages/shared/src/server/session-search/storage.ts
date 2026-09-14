import type Database from "better-sqlite3";
import { chunkText, contentHash, type ExtractedMessage, normalizeSearchText } from "./extraction";

export type SearchSource = {
  projectId: string;
  kind: "trace" | "observation";
  id: string;
  revision: number;
  eventTime?: string;
  traceId?: string;
};
export type DirtyRow = SearchSource;
const scopeFor = (projectId: string) => contentHash(projectId).slice(0, 32);
const canonicalTime = (value: string) => {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
};

export class SessionSearchStorage {
  constructor(private readonly db: Database.Database) {}

  markDirty(source: SearchSource): void {
    const write = () => {
      const next = this.db
        .prepare(`INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision)
        VALUES(@projectId,@kind,@id,1)
        ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=revision+1
        RETURNING revision`)
        .get(source) as { revision: number };
      this.db
        .prepare(`INSERT INTO search_dirty(project_id,source_kind,source_id,revision,event_time,next_attempt_at)
      VALUES(@projectId,@kind,@id,@revision,@eventTime,datetime('now'))
      ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=MAX(revision,excluded.revision),event_time=COALESCE(excluded.event_time,event_time),next_attempt_at=datetime('now'),last_error=NULL`)
        .run({ ...source, revision: next.revision, eventTime: source.eventTime ?? null });
    };
    if (this.db.inTransaction) write();
    else this.db.transaction(write)();
  }
  listDirty(limit = 100): DirtyRow[] {
    return this.db
      .prepare(`SELECT project_id as projectId, source_kind as kind, source_id as id, revision, event_time as eventTime
      FROM search_dirty WHERE next_attempt_at IS NULL OR next_attempt_at <= datetime('now')
      ORDER BY revision ASC LIMIT ?`)
      .all(Math.min(limit, 100)) as DirtyRow[];
  }
  indexSource(source: SearchSource, messages: ExtractedMessage[]): void {
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT revision FROM search_source_revisions WHERE project_id=? AND source_kind=? AND source_id=?",
        )
        .get(source.projectId, source.kind, source.id) as { revision: number } | undefined;
      if (current && current.revision > source.revision) return;
      const old = this.db
        .prepare(
          `SELECT text_id FROM search_occurrences WHERE project_id=? AND source_kind=? AND source_id=?`,
        )
        .all(source.projectId, source.kind, source.id) as { text_id: number }[];
      this.db
        .prepare(
          `DELETE FROM search_occurrences WHERE project_id=? AND source_kind=? AND source_id=?`,
        )
        .run(source.projectId, source.kind, source.id);
      for (const row of messages) {
        const chunks = chunkText(row.text);
        for (const chunk of chunks) {
          const hash = contentHash(chunk.text);
          const existing = this.db
            .prepare(
              `SELECT text_id FROM search_texts WHERE project_id=? AND content_hash=? AND chunk_no=? AND index_version=1`,
            )
            .get(source.projectId, hash, chunk.chunkNo) as { text_id: number } | undefined;
          let textId = existing?.text_id;
          if (!textId) {
            const info = this.db
              .prepare(`INSERT INTO search_texts(project_id,content_hash,chunk_no,display_text,normalized_text,project_scope)
              VALUES(?,?,?,?,?,?)`)
              .run(
                source.projectId,
                hash,
                chunk.chunkNo,
                chunk.text,
                normalizeSearchText(chunk.text),
                scopeFor(source.projectId),
              );
            textId = Number(info.lastInsertRowid);
            this.db
              .prepare(`INSERT INTO search_fts(rowid,normalized_text,project_scope) VALUES(?,?,?)`)
              .run(textId, normalizeSearchText(chunk.text), scopeFor(source.projectId));
          }
          const occurrenceId = `${source.projectId}:${source.kind}:${source.id}:${source.revision}:${row.order}:${chunk.chunkNo}`;
          this.db
            .prepare(`INSERT INTO search_occurrences(occurrence_id,project_id,text_id,source_kind,source_id,trace_id,role,field,message_order,chunk_no,source_version,event_time,display_start,display_end)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(
              occurrenceId,
              source.projectId,
              textId,
              source.kind,
              source.id,
              source.traceId ?? (source.kind === "trace" ? source.id : null),
              row.role,
              row.field,
              row.order,
              chunk.chunkNo,
              source.revision,
              canonicalTime(source.eventTime ?? new Date(0).toISOString()),
              chunk.start,
              chunk.end,
            );
        }
      }
      const oldIds = [...new Set(old.map((row) => row.text_id))];
      for (const textId of oldIds) {
        const referenced = this.db
          .prepare("SELECT 1 FROM search_occurrences WHERE project_id=? AND text_id=? LIMIT 1")
          .get(source.projectId, textId);
        if (!referenced) {
          this.db.prepare("DELETE FROM search_fts WHERE rowid=?").run(textId);
          this.db
            .prepare("DELETE FROM search_texts WHERE text_id=? AND project_id=?")
            .run(textId, source.projectId);
        }
      }
      this.db
        .prepare(
          `DELETE FROM search_dirty WHERE project_id=? AND source_kind=? AND source_id=? AND revision<=?`,
        )
        .run(source.projectId, source.kind, source.id, source.revision);
      this.db
        .prepare(
          `INSERT INTO search_index_state(project_id,coverage,pending,updated_at) VALUES(?,?,0,datetime('now')) ON CONFLICT(project_id) DO UPDATE SET coverage=CASE WHEN search_index_state.coverage='limited' THEN 'limited' ELSE 'new' END,updated_at=excluded.updated_at`,
        )
        .run(source.projectId, "new");
      void old;
    });
    tx();
  }
  markFailed(source: SearchSource, error: unknown): void {
    const update = () => {
      this.db
        .prepare(
          `UPDATE search_dirty SET attempts=attempts+1,last_error=?,next_attempt_at=datetime('now','+5 seconds') WHERE project_id=? AND source_kind=? AND source_id=?`,
        )
        .run(String(error), source.projectId, source.kind, source.id);
      this.db
        .prepare(
          `INSERT INTO search_index_state(project_id,coverage,pending,last_error,updated_at) VALUES(?, 'error',0,?,datetime('now')) ON CONFLICT(project_id) DO UPDATE SET coverage=CASE WHEN search_index_state.coverage='limited' THEN 'limited' ELSE 'error' END,last_error=excluded.last_error,updated_at=excluded.updated_at`,
        )
        .run(source.projectId, String(error));
    };
    if (this.db.inTransaction) update();
    else this.db.transaction(update)();
  }
  markLimited(source: SearchSource, reason: string): void {
    const update = () => {
      this.db
        .prepare(
          "DELETE FROM search_dirty WHERE project_id=? AND source_kind=? AND source_id=? AND revision<=?",
        )
        .run(source.projectId, source.kind, source.id, source.revision);
      this.db
        .prepare(
          "INSERT INTO search_index_state(project_id,coverage,pending,last_error,updated_at) VALUES(?, 'limited',0,?,datetime('now')) ON CONFLICT(project_id) DO UPDATE SET coverage='limited',last_error=excluded.last_error,updated_at=excluded.updated_at",
        )
        .run(source.projectId, reason);
    };
    if (this.db.inTransaction) update();
    else this.db.transaction(update)();
  }
}
