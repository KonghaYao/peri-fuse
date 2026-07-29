/**
 * GET /api/public/dashboard
 *
 * Lite-mode-only aggregate endpoint backing the lite-web dashboard. It reads
 * summary counts and a 30-day daily time series directly from the SQLite
 * telemetry store (there is no ClickHouse in lite mode).
 */

import { logger } from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";

const app = new Hono<LiteServerEnv>();

type DailyBucket = {
  date: string;
  traces: number;
  observations: number;
  cost: number;
};

const DAILY_RANGE_DAYS = 30;

app.get("/api/public/dashboard", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const db = getTelemetryDB();

  try {
    const [traceCount, observationCount, scoreCount, costRows] = await Promise.all([
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM traces WHERE project_id = @projectId AND is_deleted = 0`,
        params: { projectId },
      }),
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM observations WHERE project_id = @projectId AND is_deleted = 0`,
        params: { projectId },
      }),
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM scores WHERE project_id = @projectId AND is_deleted = 0`,
        params: { projectId },
      }),
      db.query<{ total: number | null }>({
        query: `SELECT COALESCE(SUM(total_cost), 0) as total FROM observations WHERE project_id = @projectId AND is_deleted = 0`,
        params: { projectId },
      }),
    ]);

    // Daily time series for the last N days. Timestamps are stored as
    // "YYYY-MM-DD HH:MM:SS.sss" TEXT, so SQLite's date() can bucket them.
    const since = new Date(Date.now() - DAILY_RANGE_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");

    const [dailyTraces, dailyObservations] = await Promise.all([
      db.query<{ day: string; count: number }>({
        query: `
          SELECT date(timestamp) as day, COUNT(*) as count
          FROM traces
          WHERE project_id = @projectId AND is_deleted = 0 AND timestamp >= @since
          GROUP BY day ORDER BY day ASC
        `,
        params: { projectId, since },
      }),
      db.query<{ day: string; count: number; cost: number | null }>({
        query: `
          SELECT date(start_time) as day, COUNT(*) as count,
                 COALESCE(SUM(total_cost), 0) as cost
          FROM observations
          WHERE project_id = @projectId AND is_deleted = 0 AND start_time >= @since
          GROUP BY day ORDER BY day ASC
        `,
        params: { projectId, since },
      }),
    ]);

    // Merge the two series into one row per day.
    const byDay = new Map<string, DailyBucket>();
    for (const row of dailyTraces) {
      byDay.set(row.day, {
        date: row.day,
        traces: Number(row.count),
        observations: 0,
        cost: 0,
      });
    }
    for (const row of dailyObservations) {
      const existing =
        byDay.get(row.day) ??
        ({ date: row.day, traces: 0, observations: 0, cost: 0 } as DailyBucket);
      existing.observations = Number(row.count);
      existing.cost = Number(row.cost ?? 0);
      byDay.set(row.day, existing);
    }

    const daily = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

    return c.json({
      summary: {
        totalTraces: Number(traceCount[0]?.count ?? 0),
        totalObservations: Number(observationCount[0]?.count ?? 0),
        totalScores: Number(scoreCount[0]?.count ?? 0),
        totalCost: Number(costRows[0]?.total ?? 0),
      },
      daily,
    });
  } catch (error) {
    logger.error("[lite-server] dashboard query failed", error);
    return c.json(
      {
        summary: {
          totalTraces: 0,
          totalObservations: 0,
          totalScores: 0,
          totalCost: 0,
        },
        daily: [],
      },
      200,
    );
  }
});

export default app;
