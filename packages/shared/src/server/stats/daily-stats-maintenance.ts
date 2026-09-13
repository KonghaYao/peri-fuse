import { getTelemetryDB } from "../adapters";
import { withTelemetryQuerySignal } from "../adapters/telemetry-query-context";
import { logger } from "../logger";
import { recomputeDay } from "./daily-stats";
import { startMaintenanceLoop } from "./maintenance-loop";

/** Yield to the event loop so chunked maintenance never starves HTTP traffic. */
const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Recompute today + yesterday for every project (late-arriving events). */
export async function refreshRecentDays(signal?: AbortSignal): Promise<void> {
  const db = getTelemetryDB();
  const today = new Date().toISOString().slice(0, 10);
  const yesterdayDate = new Date(`${today}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const days = [today, yesterdayDate.toISOString().slice(0, 10)];
  let cursor: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const projects: Array<{ project_id: string }> = await db.query({
      query: `SELECT DISTINCT project_id FROM traces
        WHERE (@cursor IS NULL OR project_id > @cursor) ORDER BY project_id LIMIT 200`,
      params: { cursor },
      signal,
    });
    for (const p of projects) {
      for (const day of days) {
        signal?.throwIfAborted();
        try {
          await recomputeDay(p.project_id, day);
        } catch (error) {
          if (!signal?.aborted) logger.error("[daily-stats] refresh failed", error);
        }
      }
    }
    if (projects.length < 200) break;
    cursor = projects[projects.length - 1].project_id;
    await yieldLoop();
  }
}

/**
 * One-time backfill: recompute every (project, day) present in the raw tables
 * but missing from daily_stats. Runs chunked so startup never blocks.
 */
export async function backfillMissingDays(signal?: AbortSignal): Promise<number> {
  const db = getTelemetryDB();
  let projectCursor: string | null = null;
  let dayCursor = "";
  let done = 0;
  for (;;) {
    signal?.throwIfAborted();
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
      ORDER BY project_id, day LIMIT 200`,
      params: { projectCursor, dayCursor },
      signal,
    });
    for (const c of missing) {
      signal?.throwIfAborted();
      try {
        await recomputeDay(c.project_id, c.day);
        done++;
      } catch (error) {
        if (!signal?.aborted)
          logger.error(`[daily-stats] Backfill failed for ${c.project_id} ${c.day}`, error);
      }
      await yieldLoop();
    }
    if (missing.length < 200) break;
    const last = missing[missing.length - 1];
    projectCursor = last.project_id;
    dayCursor = last.day;
  }
  if (done > 0) logger.info(`[daily-stats] Backfill complete (${done} day(s))`);
  return done;
}

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Start maintenance: initial backfill + periodic refresh of recent days.
 * Returns a stop function (used for graceful shutdown / tests).
 */
export function startDailyStatsMaintenance(intervalMs = REFRESH_INTERVAL_MS): () => void {
  return startMaintenanceLoop(
    (signal) => withTelemetryQuerySignal(signal, () => backfillMissingDays(signal)),
    (signal) => withTelemetryQuerySignal(signal, () => refreshRecentDays(signal)),
    intervalMs,
    (error) => logger.error("[daily-stats] maintenance failed", error),
  );
}
