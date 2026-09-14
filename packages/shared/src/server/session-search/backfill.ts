import type Database from "better-sqlite3";
import { SessionSearchStorage } from "./storage";
export function enqueueBackfill(db: Database.Database): number {
  if (db.prepare("SELECT 1 FROM search_dirty LIMIT 1").get()) return 0;
  const storage = new SessionSearchStorage(db);
  const enqueue = db.transaction(() => {
    const state = db
      .prepare(
        "SELECT trace_cursor,observation_cursor FROM search_index_state WHERE project_id='__backfill__'",
      )
      .get() as { trace_cursor: number; observation_cursor: number } | undefined;
    let tc = state?.trace_cursor ?? 0;
    let oc = state?.observation_cursor ?? 0;
    let added = 0;
    const traces = db
      .prepare(
        "SELECT rowid,project_id,id,timestamp FROM traces WHERE rowid>? ORDER BY rowid LIMIT 100",
      )
      .all(tc) as { rowid: number; project_id: string; id: string; timestamp: string }[];
    for (const r of traces) {
      storage.markDirty({
        projectId: r.project_id,
        kind: "trace",
        id: r.id,
        revision: 0,
        eventTime: r.timestamp,
      });
      added++;
    }
    tc = traces.at(-1)?.rowid ?? tc;
    const obs = db
      .prepare(
        "SELECT rowid,project_id,id,start_time FROM observations WHERE rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(oc, 100 - added) as {
      rowid: number;
      project_id: string;
      id: string;
      start_time: string;
    }[];
    for (const r of obs) {
      storage.markDirty({
        projectId: r.project_id,
        kind: "observation",
        id: r.id,
        revision: 0,
        eventTime: r.start_time,
      });
      added++;
    }
    oc = obs.at(-1)?.rowid ?? oc;
    const coverage = traces.length === 0 && obs.length === 0 ? "ready" : "backfill";
    db.prepare(
      "INSERT INTO search_index_state(project_id,coverage,trace_cursor,observation_cursor) VALUES('__backfill__',?,?,?) ON CONFLICT(project_id) DO UPDATE SET coverage=?,trace_cursor=?,observation_cursor=?",
    ).run(coverage, tc, oc, coverage, tc, oc);
    return added;
  });
  return enqueue();
}
