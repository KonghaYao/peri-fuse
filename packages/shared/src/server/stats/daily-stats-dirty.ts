import type { LocalExecutor } from "../../db/local";
import { getTelemetryDB } from "../adapters";

const RETRY_INTERVAL_MS = 30_000;
const nextRetry = new Map<string, number>();

/** 触发器与实体共享事务；旧/新日期均持久化，不依赖两天刷新窗口。 */
export const DAILY_STATS_DIRTY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS daily_stats_dirty (
    project_id TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    dirty INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(project_id, day));
  CREATE TABLE IF NOT EXISTS telemetry_retention_state (
    id INTEGER PRIMARY KEY CHECK(id=1), cutoff_day TEXT NOT NULL);`;

export async function initializeDailyStatsDirty(db: LocalExecutor): Promise<void> {
  await db.exec(DAILY_STATS_DIRTY_SCHEMA_SQL);
}

/** One read makes one repair attempt per day; concurrent writes leave the row dirty for a later pass. */
export async function repairDirtyDays(
  projectId: string,
  recompute: (projectId: string, day: string) => Promise<void>,
  fromDay: string | null = null,
  toDay: string | null = null,
): Promise<void> {
  const db = getTelemetryDB();
  const dirty = await db.query<{ day: string }>({
    query: `SELECT day FROM daily_stats_dirty WHERE project_id=@projectId AND dirty=1
      AND (@fromDay IS NULL OR day >= @fromDay)
      AND (@toDay IS NULL OR day <= @toDay)
      AND NOT EXISTS (SELECT 1 FROM telemetry_retention_state WHERE day < cutoff_day)
      ORDER BY day LIMIT 32`,
    params: { projectId, fromDay, toDay },
  });
  for (const { day } of dirty) {
    const key = JSON.stringify([projectId, day]);
    if ((nextRetry.get(key) ?? 0) > Date.now()) continue;
    await recompute(projectId, day);
    const [state] = await db.query<{ dirty: number }>({
      query: "SELECT dirty FROM daily_stats_dirty WHERE project_id=@projectId AND day=@day",
      params: { projectId, day },
    });
    if (state?.dirty === 1) {
      // Continuous writes can invalidate every snapshot; let the background pass retry.
      if (nextRetry.size >= 1000) nextRetry.clear();
      nextRetry.set(key, Date.now() + RETRY_INTERVAL_MS);
    } else {
      nextRetry.delete(key);
    }
  }
}
