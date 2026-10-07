import { type LocalExecutor, withLocalTransaction } from "../../db/local";
import { SessionSearchStorage } from "./storage";
export async function enqueueBackfill(db: LocalExecutor): Promise<number> {
  if (await db.get("SELECT 1 FROM search_dirty LIMIT 1")) return 0;
  return withLocalTransaction(db, async (tx) => {
    const db = tx;
    const storage = new SessionSearchStorage(tx);
    const state = (await db.get(
      "SELECT trace_cursor,observation_cursor FROM search_index_state WHERE project_id='__backfill__'",
    )) as { trace_cursor: number; observation_cursor: number } | undefined;
    let tc = state?.trace_cursor ?? 0;
    let oc = state?.observation_cursor ?? 0;
    let added = 0;
    const traces = (await db.all(
      "SELECT rowid,project_id,id,timestamp FROM traces WHERE rowid>? ORDER BY rowid LIMIT 100",
      tc,
    )) as { rowid: number; project_id: string; id: string; timestamp: string }[];
    for (const r of traces) {
      await storage.markDirty({
        projectId: r.project_id,
        kind: "trace",
        id: r.id,
        revision: 0,
        eventTime: r.timestamp,
      });
      added++;
    }
    tc = traces.at(-1)?.rowid ?? tc;
    const obs = (await db.all(
      "SELECT rowid,project_id,id,start_time FROM observations WHERE rowid>? ORDER BY rowid LIMIT ?",
      oc,
      100 - added,
    )) as {
      rowid: number;
      project_id: string;
      id: string;
      start_time: string;
    }[];
    for (const r of obs) {
      await storage.markDirty({
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
    await db.run(
      "INSERT INTO search_index_state(project_id,coverage,trace_cursor,observation_cursor) VALUES('__backfill__',?,?,?) ON CONFLICT(project_id) DO UPDATE SET coverage=?,trace_cursor=?,observation_cursor=?",
      coverage,
      tc,
      oc,
      coverage,
      tc,
      oc,
    );
    return added;
  });
}
