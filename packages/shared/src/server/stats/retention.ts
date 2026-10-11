/**
 * Optional telemetry retention.
 *
 * When PERIFUSE_TELEMETRY_RETENTION_DAYS is set to a positive number, rows
 * older than the cutoff are purged from the telemetry store (observations,
 * scores, traces, trace_metrics and the daily rollups). Disabled by default.
 *
 * Deletes run **per project** in bounded chunks (500 rows per transaction,
 * mirroring scripts/prune-telemetry.mjs) so a large purge never holds the write
 * lock (or the event loop) for long; the job yields between chunks. Deleting
 * rows does not shrink the file: an in-place VACUUM is **not supported** by this
 * Turso configuration, reclaiming space needs an offline export/rebuild (see
 * scripts/prune-telemetry.mjs). CAS pool content that loses its last root is
 * reclaimed by the GC pass requested after each retention pass.
 */

import { getTelemetryDB } from "../adapters";
import { requestCasGcPass, startCasGcJob } from "../io-cas/gc-job";
import { logger } from "../logger";
import { startMaintenanceLoop } from "./maintenance-loop";

const ENV_RETENTION_DAYS = "PERIFUSE_TELEMETRY_RETENTION_DAYS";
/** 每个项目、每个事务最多删除的行数（原 50,000 行单批改为有界小批）。 */
export const RETENTION_CHUNK_ROWS = 500;
const RETENTION_CHECK_INTERVAL_MS = 6 * 3600_000;

export function resolveRetentionDays(): number {
  const raw = process.env[ENV_RETENTION_DAYS];
  const days = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface RetentionTarget {
  table: string;
  where: string;
}

/**
 * Distinct 项目列表（按 project_id 升序）。所有保留目标表的 project_id 都是索引前缀，
 * `DISTINCT ... ORDER BY` 走 index skip-scan，不是全表扫描。
 */
async function listProjects(table: string): Promise<string[]> {
  const rows = await getTelemetryDB().query<{ project_id: unknown }>({
    query: `SELECT DISTINCT project_id FROM ${table} ORDER BY project_id`,
  });
  return rows.map((row) => String(row.project_id)).filter((projectId) => projectId.length > 0);
}

/**
 * 按项目有界删除：每个事务只删一个项目的一批（≤`RETENTION_CHUNK_ROWS` 行），
 * 批间让出事件循环；项目间互不阻塞，单个大项目也不会独占用一次 purges 的全部写锁时间。
 */
async function purgeTable(
  target: RetentionTarget,
  cutoff: string,
  cutoffDay: string,
  signal?: AbortSignal,
): Promise<number> {
  const db = getTelemetryDB();
  const projects = await listProjects(target.table);
  let total = 0;
  for (const projectId of projects) {
    for (;;) {
      signal?.throwIfAborted();
      const res = await db.command({
        query: `DELETE FROM ${target.table} WHERE rowid IN (
                  SELECT rowid FROM ${target.table}
                  WHERE project_id = @projectId AND ${target.where}
                  LIMIT ${RETENTION_CHUNK_ROWS}
                )`,
        params: { projectId, cutoff, cutoffDay },
      });
      total += res.changes;
      if (res.changes < RETENTION_CHUNK_ROWS) break;
      await yieldLoop();
    }
  }
  return total;
}

/**
 * Delete rows older than `cutoff` (SQLite TEXT timestamp) across all
 * telemetry tables. Returns total deleted rows per table.
 */
export async function purgeOlderThan(
  cutoff: string,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const db = getTelemetryDB();
  const cutoffDay = cutoff.slice(0, 10);
  // 持久化完整日期淘汰边界，阻止其他连接的在途快照重新发布过期桶。
  signal?.throwIfAborted();
  await db.command({
    query: `INSERT INTO telemetry_retention_state(id, cutoff_day) VALUES(1, @cutoffDay)
      ON CONFLICT(id) DO UPDATE SET cutoff_day=MAX(cutoff_day, excluded.cutoff_day)`,
    params: { cutoffDay },
  });
  const targets: RetentionTarget[] = [
    { table: "observations", where: "start_time < @cutoff" },
    { table: "scores", where: "timestamp < @cutoff" },
    { table: "traces", where: "timestamp < @cutoff" },
    { table: "trace_metrics", where: "(timestamp IS NULL OR timestamp < @cutoff)" },
    { table: "daily_stats", where: "day < @cutoffDay" },
    { table: "daily_model_stats", where: "day < @cutoffDay" },
    { table: "daily_stats_dirty", where: "day < @cutoffDay" },
    {
      table: "ingestion_field_versions",
      where: ["traces", "observations", "scores"]
        .map(
          (table) =>
            `(entity_type='${table}' AND NOT EXISTS (SELECT 1 FROM ${table} e
          WHERE e.project_id=ingestion_field_versions.project_id
            AND e.id=ingestion_field_versions.entity_id))`,
        )
        .join(" OR "),
    },
  ];

  const deleted: Record<string, number> = {};
  for (const target of targets) {
    deleted[target.table] = await purgeTable(target, cutoff, cutoffDay, signal);
  }
  return deleted;
}

/** Run one retention pass (no-op when retention is disabled). */
export async function runRetentionOnce(signal?: AbortSignal): Promise<void> {
  const days = resolveRetentionDays();
  if (days <= 0) return;
  const cutoffDate = new Date(Date.now() - days * 24 * 3600_000);
  const cutoff = cutoffDate.toISOString().replace("T", " ").replace("Z", "");
  try {
    const deleted = await purgeOlderThan(cutoff, signal);
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      logger.info(
        `[retention] Purged ${total} row(s) older than ${days}d: ${JSON.stringify(deleted)}`,
      );
    }
  } catch (error) {
    if (!signal?.aborted) logger.error("[retention] Purge failed", error);
  }
  // 行删除后失去根的池内容由 GC 回收（GC 关闭时该请求是 no-op）。
  requestCasGcPass();
}

/**
 * Start the maintenance jobs: retention (immediate pass + periodic re-check) and
 * the CAS GC job (default 6h, enabled by `PERIFUSE_IO_CAS_GC=on` only; it does
 * not depend on retention being enabled). Returns a stop function for both.
 */
export function startRetentionJob(intervalMs = RETENTION_CHECK_INTERVAL_MS): () => Promise<void> {
  const stopCasGc = startCasGcJob();
  if (resolveRetentionDays() <= 0)
    return async () => {
      await stopCasGc();
    };
  logger.info(
    `[retention] Enabled with PERIFUSE_TELEMETRY_RETENTION_DAYS=${resolveRetentionDays()}`,
  );
  const stopRetention = startMaintenanceLoop(
    runRetentionOnce,
    runRetentionOnce,
    intervalMs,
    (error) => logger.error("[retention] Maintenance failed", error),
  );
  return async () => {
    await Promise.all([stopRetention(), stopCasGc()]);
  };
}
