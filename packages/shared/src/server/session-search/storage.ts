import { type LocalExecutor, withLocalTransaction } from "../../db/local";
import { chunkText, contentHash, type ExtractedMessage, normalizeSearchText } from "./extraction";
import { searchTrigrams } from "./schema";

export type SearchSource = {
  projectId: string;
  kind: "trace" | "observation";
  id: string;
  revision: number;
  traceId?: string | null;
  eventTime?: string;
};
type DirtyRow = SearchSource;

const canonicalTime = (value: string) => {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
};

async function syncPending(db: LocalExecutor, projectId: string, delta = 0): Promise<void> {
  await db.run(
    `INSERT INTO search_index_state(project_id,pending,updated_at)
    VALUES(@projectId,max(0,@delta),datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET pending=max(0,pending+@delta),updated_at=excluded.updated_at`,
    { projectId, delta },
  );
}

export class SessionSearchStorage {
  constructor(private readonly db: LocalExecutor) {}

  async markDirty(source: SearchSource): Promise<void> {
    await withLocalTransaction(this.db, async (tx) => {
      const existing = await tx.get(
        "SELECT 1 FROM search_dirty WHERE project_id=? AND source_kind=? AND source_id=?",
        source.projectId,
        source.kind,
        source.id,
      );
      const next = await tx.get(
        `INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision)
        VALUES(?,?,?,1) ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET revision=revision+1 RETURNING revision`,
        source.projectId,
        source.kind,
        source.id,
      );
      await tx.run(
        `INSERT INTO search_dirty(project_id,source_kind,source_id,revision,event_time,next_attempt_at)
        VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(project_id,source_kind,source_id)
        DO UPDATE SET revision=excluded.revision,event_time=COALESCE(excluded.event_time,event_time),next_attempt_at=datetime('now'),last_error=NULL`,
        source.projectId,
        source.kind,
        source.id,
        next.revision,
        source.eventTime ?? null,
      );
      await syncPending(tx, source.projectId, existing ? 0 : 1);
    });
  }

  async listDirty(limit = 100): Promise<DirtyRow[]> {
    return this.db.all(
      `SELECT project_id AS projectId,source_kind AS kind,source_id AS id,revision,event_time AS eventTime
      FROM search_dirty WHERE next_attempt_at IS NULL OR next_attempt_at<=datetime('now') ORDER BY revision LIMIT ?`,
      Math.min(limit, 100),
    );
  }

  async indexSource(source: SearchSource, messages: ExtractedMessage[]): Promise<void> {
    await withLocalTransaction(this.db, async (tx) => {
      const current = await tx.get(
        "SELECT revision FROM search_source_revisions WHERE project_id=? AND source_kind=? AND source_id=?",
        source.projectId,
        source.kind,
        source.id,
      );
      if (current && current.revision > source.revision) return;
      const old = await tx.all(
        "SELECT text_id FROM search_occurrences WHERE project_id=? AND source_kind=? AND source_id=?",
        source.projectId,
        source.kind,
        source.id,
      );
      await tx.run(
        "DELETE FROM search_occurrences WHERE project_id=? AND source_kind=? AND source_id=?",
        source.projectId,
        source.kind,
        source.id,
      );
      for (const message of messages) {
        for (const chunk of chunkText(message.text)) {
          const hash = contentHash(chunk.text);
          const existing = await tx.get(
            "SELECT text_id FROM search_texts WHERE project_id=? AND content_hash=? AND chunk_no=? AND index_version=1",
            source.projectId,
            hash,
            chunk.chunkNo,
          );
          let textId = existing?.text_id;
          if (!textId) {
            const normalized = normalizeSearchText(chunk.text);
            const result = await tx.run(
              "INSERT INTO search_texts(project_id,content_hash,chunk_no,display_text,normalized_text,project_scope) VALUES(?,?,?,?,?,?)",
              source.projectId,
              hash,
              chunk.chunkNo,
              chunk.text,
              normalized,
              contentHash(source.projectId).slice(0, 32),
            );
            textId = Number(result.lastInsertRowid);
            const grams = searchTrigrams(normalized);
            for (let offset = 0; offset < grams.length; offset += 250) {
              const batch = grams.slice(offset, offset + 250);
              await tx.run(
                `INSERT INTO search_trigrams(project_id,gram,text_id) VALUES ${batch.map(() => "(?,?,?)").join(",")}`,
                ...batch.flatMap((gram) => [source.projectId, gram, textId]),
              );
            }
          }
          const occurrenceId = `${source.projectId}:${source.kind}:${source.id}:${source.revision}:${message.order}:${chunk.chunkNo}`;
          await tx.run(
            `INSERT INTO search_occurrences(occurrence_id,project_id,text_id,source_kind,source_id,trace_id,role,field,message_order,chunk_no,source_version,event_time,display_start,display_end)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            occurrenceId,
            source.projectId,
            textId,
            source.kind,
            source.id,
            source.traceId ?? (source.kind === "trace" ? source.id : null),
            message.role,
            message.field,
            message.order,
            chunk.chunkNo,
            source.revision,
            canonicalTime(source.eventTime ?? new Date(0).toISOString()),
            chunk.start,
            chunk.end,
          );
        }
      }
      for (const textId of new Set(old.map((row) => row.text_id))) {
        if (
          !(await tx.get(
            "SELECT 1 FROM search_occurrences WHERE project_id=? AND text_id=? LIMIT 1",
            source.projectId,
            textId,
          ))
        ) {
          await tx.run(
            "DELETE FROM search_trigrams WHERE project_id=? AND text_id=?",
            source.projectId,
            textId,
          );
          await tx.run(
            "DELETE FROM search_texts WHERE project_id=? AND text_id=?",
            source.projectId,
            textId,
          );
        }
      }
      const removed = await tx.run(
        "DELETE FROM search_dirty WHERE project_id=? AND source_kind=? AND source_id=? AND revision<=?",
        source.projectId,
        source.kind,
        source.id,
        source.revision,
      );
      await tx.run(
        `INSERT INTO search_index_state(project_id,coverage,updated_at) VALUES(?,'new',datetime('now'))
        ON CONFLICT(project_id) DO UPDATE SET coverage=CASE WHEN coverage='limited' THEN 'limited' ELSE 'new' END,last_error=NULL,updated_at=excluded.updated_at`,
        source.projectId,
      );
      await syncPending(tx, source.projectId, -Number(removed.changes));
    });
  }

  async markFailed(source: SearchSource, error: unknown): Promise<void> {
    await withLocalTransaction(this.db, async (tx) => {
      const message = error instanceof Error ? error.name : "Indexing failed";
      await tx.run(
        "UPDATE search_dirty SET attempts=attempts+1,last_error=?,next_attempt_at=datetime('now','+5 seconds') WHERE project_id=? AND source_kind=? AND source_id=?",
        message,
        source.projectId,
        source.kind,
        source.id,
      );
      await tx.run(
        `INSERT INTO search_index_state(project_id,coverage,last_error) VALUES(?,'error',?)
        ON CONFLICT(project_id) DO UPDATE SET coverage=CASE WHEN coverage='limited' THEN 'limited' ELSE 'error' END,last_error=excluded.last_error`,
        source.projectId,
        message,
      );
      await syncPending(tx, source.projectId);
    });
  }

  async markLimited(source: SearchSource, reason: string): Promise<void> {
    await withLocalTransaction(this.db, async (tx) => {
      const removed = await tx.run(
        "DELETE FROM search_dirty WHERE project_id=? AND source_kind=? AND source_id=? AND revision<=?",
        source.projectId,
        source.kind,
        source.id,
        source.revision,
      );
      await tx.run(
        "INSERT INTO search_index_state(project_id,coverage,last_error) VALUES(?,'limited',?) ON CONFLICT(project_id) DO UPDATE SET coverage='limited',last_error=excluded.last_error",
        source.projectId,
        reason,
      );
      await syncPending(tx, source.projectId, -Number(removed.changes));
    });
  }
}
