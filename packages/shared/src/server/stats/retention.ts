/**
 * Optional telemetry retention.
 *
 * When PERIFUSE_TELEMETRY_RETENTION_DAYS is set to a positive number, rows
 * older than the cutoff are purged from the telemetry store (observations,
 * scores, traces, trace_metrics and the daily rollups). Disabled by default.
 *
 * Deletes run in chunks so a large purge never holds the write lock (or the
 * event loop) for long; the job yields between chunks. File size is not
 * reclaimed until VACUUM — run scripts/prune-telemetry.mjs --vacuum for that.
 */

import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";
import { startMaintenanceLoop } from "./maintenance-loop";

const ENV_RETENTION_DAYS = "PERIFUSE_TELEMETRY_RETENTION_DAYS";
const CHUNK_SIZE = 50_000;
const RETENTION_CHECK_INTERVAL_MS = 6 * 3600_000;

export function resolveRetentionDays(): number {
  const raw = process.env[ENV_RETENTION_DAYS];
  const days = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  const targets: Array<{ table: string; where: string }> = [
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
  for (const t of targets) {
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const res = await db.command({
        query: `DELETE FROM ${t.table} WHERE rowid IN (
                  SELECT rowid FROM ${t.table} WHERE ${t.where} LIMIT ${CHUNK_SIZE}
                )`,
        params: { cutoff, cutoffDay },
      });
      const changes = res.changes;
      total += changes;
      if (changes < CHUNK_SIZE) break;
      await yieldLoop();
    }
    deleted[t.table] = total;
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
}

/** Start the retention job (immediate pass + periodic re-check). */
export function startRetentionJob(intervalMs = RETENTION_CHECK_INTERVAL_MS): () => Promise<void> {
  if (resolveRetentionDays() <= 0) return async () => {};
  logger.info(
    `[retention] Enabled with PERIFUSE_TELEMETRY_RETENTION_DAYS=${resolveRetentionDays()}`,
  );
  return startMaintenanceLoop(runRetentionOnce, runRetentionOnce, intervalMs, (error) =>
    logger.error("[retention] Maintenance failed", error),
  );
}
