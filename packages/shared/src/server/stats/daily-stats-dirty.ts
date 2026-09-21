import type Database from "better-sqlite3";
import { getTelemetryDB } from "../adapters";

/** 触发器与实体共享事务；旧/新日期均持久化，不依赖两天刷新窗口。 */
export function initializeDailyStatsDirty(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_stats_dirty (
    project_id TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    dirty INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(project_id, day))`);
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry_retention_state (
    id INTEGER PRIMARY KEY CHECK(id=1), cutoff_day TEXT NOT NULL)`);
  for (const table of ["traces", "observations", "scores"]) {
    const time = table === "observations" ? "start_time" : "timestamp";
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const rows =
        operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
      const statements = rows
        .map(
          (row) => `
        INSERT INTO daily_stats_dirty(project_id, day) SELECT ${row}.project_id, substr(${row}.${time},1,10)
          WHERE ${row}.${time} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM telemetry_retention_state
              WHERE substr(${row}.${time},1,10) < cutoff_day)
          ON CONFLICT(project_id,day) DO UPDATE SET revision=revision+1, dirty=1;`,
        )
        .join("\n");
      db.transaction(() => {
        db.exec(`DROP TRIGGER IF EXISTS ingestion_daily_${table}_${operation};
          CREATE TRIGGER ingestion_daily_${table}_${operation}
          AFTER ${operation} ON ${table} BEGIN ${statements} END`);
      })();
    }
  }
}

/** 重算失败保留 dirty；并发写入改变 revision 时重算，不能清除新写入的补偿任务。 */
export async function repairDirtyDays(
  projectId: string,
  recompute: (projectId: string, day: string) => Promise<void>,
): Promise<void> {
  const db = getTelemetryDB();
  for (let attempt = 0; attempt < 8; attempt++) {
    const dirty = await db.query<{ day: string; revision: number }>({
      query: `SELECT day,revision FROM daily_stats_dirty WHERE project_id=@projectId AND dirty=1
        AND NOT EXISTS (SELECT 1 FROM telemetry_retention_state WHERE day < cutoff_day)`,
      params: { projectId },
    });
    if (!dirty.length) return;
    for (const { day } of dirty) await recompute(projectId, day);
  }
  throw new Error("Daily statistics changed during repair; retry the read");
}
