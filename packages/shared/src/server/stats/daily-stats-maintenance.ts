import { getTelemetryDB } from "../adapters";
import { withTelemetryQuerySignal } from "../adapters/telemetry-query-context";
import { logger } from "../logger";
import { recomputeDay } from "./daily-stats";
import { startMaintenanceLoop } from "./maintenance-loop";

/** Yield to the event loop so chunked maintenance never starves HTTP traffic. */
const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const DIRTY_BATCH_SIZE = 20;
const BACKFILL_BATCH_SIZE = 10;
type DayCursor = { projectId: string | null; day: string; hadFailure?: boolean };

/** Repair a bounded page of changed days, including late arrivals on older days. */
export async function refreshRecentDays(
  signal?: AbortSignal,
  cursor: DayCursor = { projectId: null, day: "" },
): Promise<void> {
  const db = getTelemetryDB();
  const getPage = () =>
    db.query<{ project_id: string; day: string }>({
      query: `SELECT project_id, day FROM daily_stats_dirty
        WHERE dirty=1 AND (@projectId IS NULL OR (project_id,day) > (@projectId,@day))
          AND NOT EXISTS (SELECT 1 FROM telemetry_retention_state WHERE day < cutoff_day)
        ORDER BY project_id,day LIMIT @limit`,
      params: { projectId: cursor.projectId, day: cursor.day, limit: DIRTY_BATCH_SIZE },
      signal,
    });
  signal?.throwIfAborted();
  let pending = await getPage();
  if (!pending.length && cursor.projectId !== null) {
    cursor.projectId = null;
    cursor.day = "";
    pending = await getPage();
  }
  for (const { project_id, day } of pending) {
    signal?.throwIfAborted();
    try {
      await recomputeDay(project_id, day);
    } catch (error) {
      if (!signal?.aborted)
        logger.error(`[daily-stats] refresh failed for ${project_id} ${day}`, error);
    }
    cursor.projectId = project_id;
    cursor.day = day;
    await yieldLoop();
  }
  if (pending.length < DIRTY_BATCH_SIZE) {
    cursor.projectId = null;
    cursor.day = "";
  }
}

/**
 * One-time backfill: recompute every (project, day) present in the raw tables
 * but missing from daily_stats. Runs chunked so startup never blocks.
 */
export async function backfillMissingDays(
  signal?: AbortSignal,
  maxDays = Number.MAX_SAFE_INTEGER,
  cursor: DayCursor = { projectId: null, day: "" },
): Promise<number> {
  const db = getTelemetryDB();
  let done = 0;
  let examined = 0;
  for (;;) {
    signal?.throwIfAborted();
    const limit = Math.min(200, maxDays - examined);
    if (limit <= 0) break;
    // Filter already materialized days in SQLite and hold only one bounded page.
    // Advance past failures too, so a malformed day cannot trap startup in a loop.
    const missing: Array<{ project_id: string; day: string }> = await db.query({
      query: `WITH days AS (
        SELECT project_id, date(start_time) AS day FROM observations
        UNION SELECT project_id, date(timestamp) AS day FROM traces
        UNION SELECT project_id, date(timestamp) AS day FROM scores
      ) SELECT project_id, day FROM days d
      WHERE day IS NOT NULL
        AND (@projectCursor IS NULL OR (project_id, day) > (@projectCursor, @dayCursor))
        AND NOT EXISTS (SELECT 1 FROM daily_stats s WHERE s.project_id = d.project_id AND s.day = d.day)
      ORDER BY project_id, day LIMIT @limit`,
      params: { projectCursor: cursor.projectId, dayCursor: cursor.day, limit },
      signal,
    });
    for (const c of missing) {
      signal?.throwIfAborted();
      examined++;
      try {
        await recomputeDay(c.project_id, c.day);
        done++;
      } catch (error) {
        cursor.hadFailure = true;
        if (!signal?.aborted)
          logger.error(`[daily-stats] Backfill failed for ${c.project_id} ${c.day}`, error);
      }
      await yieldLoop();
    }
    if (missing.length < limit) {
      cursor.projectId = null;
      cursor.day = "";
      break;
    }
    const last = missing[missing.length - 1];
    cursor.projectId = last.project_id;
    cursor.day = last.day;
  }
  if (done > 0) logger.info(`[daily-stats] Backfill complete (${done} day(s))`);
  return done;
}

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Start maintenance: initial backfill + periodic refresh of recent days.
 * Returns a stop function (used for graceful shutdown / tests).
 */
export function startDailyStatsMaintenance(intervalMs = REFRESH_INTERVAL_MS): () => Promise<void> {
  const backfillCursor: DayCursor = { projectId: null, day: "" };
  const dirtyCursor: DayCursor = { projectId: null, day: "" };
  let backfillComplete = false;
  const backfillPage = async (signal: AbortSignal) => {
    if (backfillComplete) return;
    const count = await backfillMissingDays(signal, BACKFILL_BATCH_SIZE, backfillCursor);
    backfillComplete = count < BACKFILL_BATCH_SIZE && !backfillCursor.hadFailure;
    if (backfillCursor.projectId === null) backfillCursor.hadFailure = false;
  };
  return startMaintenanceLoop(
    (signal) => withTelemetryQuerySignal(signal, () => backfillPage(signal)),
    (signal) =>
      withTelemetryQuerySignal(signal, async () => {
        await backfillPage(signal);
        await refreshRecentDays(signal, dirtyCursor);
      }),
    intervalMs,
    (error) => logger.error("[daily-stats] maintenance failed", error),
  );
}
