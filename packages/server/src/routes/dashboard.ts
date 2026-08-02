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

type ModelBucket = {
  model: string;
  observations: number;
  tokens: number;
  cost: number;
};

type LevelBucket = {
  level: string;
  count: number;
};

const DAILY_RANGE_DAYS = 30;

app.get("/api/public/dashboard", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const db = getTelemetryDB();

  try {
    const [traceCount, observationCount, scoreCount, costRows, tokenRows, userRows] =
      await Promise.all([
        db.query<{ count: number }>({
          query: `SELECT COUNT(*) as count FROM traces WHERE project_id = @projectId AND is_deleted = 0`,
          params: { projectId },
        }),
        db.query<{ count: number }>({
          query: `SELECT COALESCE(SUM(obs_count), 0) as count FROM trace_metrics WHERE project_id = @projectId`,
          params: { projectId },
        }),
        db.query<{ count: number }>({
          query: `SELECT COUNT(*) as count FROM scores WHERE project_id = @projectId AND is_deleted = 0`,
          params: { projectId },
        }),
        db.query<{ total: number | null }>({
          query: `SELECT COALESCE(SUM(total_cost), 0) as total FROM trace_metrics WHERE project_id = @projectId`,
          params: { projectId },
        }),
        db.query<{
          total: number | null;
          cached: number | null;
          gross: number | null;
        }>({
          query: `SELECT COALESCE(SUM(total_tokens), 0) as total,
                         COALESCE(SUM(cached_tokens), 0) as cached,
                         COALESCE(SUM(gross_input_tokens), 0) as gross
                  FROM trace_metrics WHERE project_id = @projectId`,
          params: { projectId },
        }),
        db.query<{ count: number }>({
          query: `SELECT COUNT(DISTINCT user_id) as count FROM traces WHERE project_id = @projectId AND is_deleted = 0 AND user_id IS NOT NULL`,
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

    // Per-model breakdown (generations only) and observation level mix.
    // Bounded to the same time window as the daily series.
    const [modelRows, levelRows] = await Promise.all([
      db.query<{
        model: string | null;
        observations: number;
        tokens: number | null;
        cost: number | null;
      }>({
        query: `
          SELECT model, COUNT(*) as observations,
                 COALESCE(SUM(COALESCE(json_extract(usage_details, '$.total'), json_extract(usage_details, '$.input') + json_extract(usage_details, '$.output'), 0)), 0) as tokens,
                 COALESCE(SUM(total_cost), 0) as cost
          FROM observations
          WHERE project_id = @projectId AND is_deleted = 0 AND type = 'GENERATION'
            AND start_time >= @since
          GROUP BY model ORDER BY cost DESC LIMIT 6
        `,
        params: { projectId, since },
      }),
      db.query<{ level: string | null; count: number }>({
        query: `
          SELECT level, COUNT(*) as count FROM observations
          WHERE project_id = @projectId AND is_deleted = 0
            AND start_time >= @since
          GROUP BY level ORDER BY count DESC
        `,
        params: { projectId, since },
      }),
    ]);

    const byModel: ModelBucket[] = modelRows.map((r) => ({
      model: r.model ?? "(unknown)",
      observations: Number(r.observations),
      tokens: Number(r.tokens ?? 0),
      cost: Number(r.cost ?? 0),
    }));
    const levels: LevelBucket[] = levelRows.map((r) => ({
      level: r.level ?? "DEFAULT",
      count: Number(r.count),
    }));

    // Cache hit rate = cached read tokens / gross input tokens. The materialized
    // `gross_input_tokens` already resolves the per-provider `input` convention
    // (gross for Anthropic, net+cache for OpenAI/OTLP), so it is the correct
    // denominator — adding cached onto `input` again would double-count.
    const totalCachedTokens = Number(tokenRows[0]?.cached ?? 0);
    const grossInput = Number(tokenRows[0]?.gross ?? 0);
    const cacheHitRate = grossInput > 0 ? totalCachedTokens / grossInput : 0;

    return c.json({
      summary: {
        totalTraces: Number(traceCount[0]?.count ?? 0),
        totalObservations: Number(observationCount[0]?.count ?? 0),
        totalScores: Number(scoreCount[0]?.count ?? 0),
        totalCost: Number(costRows[0]?.total ?? 0),
        totalTokens: Number(tokenRows[0]?.total ?? 0),
        totalCachedTokens,
        cacheHitRate,
        totalUsers: Number(userRows[0]?.count ?? 0),
      },
      daily,
      byModel,
      levels,
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
          totalTokens: 0,
          totalCachedTokens: 0,
          cacheHitRate: 0,
          totalUsers: 0,
        },
        daily: [],
        byModel: [],
        levels: [],
      },
      200,
    );
  }
});

export default app;
