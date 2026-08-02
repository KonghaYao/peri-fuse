/**
 * GET /api/public/dashboard
 *
 * Lite-mode-only aggregate endpoint backing the lite-web dashboard. It reads
 * summary counts, latency percentiles, error/score aggregates and a daily time
 * series directly from the SQLite telemetry store (no ClickHouse in lite mode).
 *
 * Accepts optional `from` / `to` ISO-instant query params to bound the window;
 * when omitted, stats cover all time.
 */

import { logger } from "@peri-fuse/shared/src/server";
import {
  getTelemetryDB,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";

const app = new Hono<LiteServerEnv>();

type DailyBucket = {
  date: string;
  traces: number;
  observations: number;
  tokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errors: number;
  cacheHitRate: number;
  avgScore: number | null;
};

type ModelBucket = {
  model: string;
  observations: number;
  tokens: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

type LevelBucket = {
  level: string;
  count: number;
};

type UserBucket = {
  userId: string;
  traces: number;
  tokens: number;
};

type RecentError = {
  id: string;
  name: string | null;
  type: string | null;
  startTime: string | null;
  statusMessage: string | null;
  traceId: string | null;
  model: string | null;
};

/** Generation latency in ms (NULL when either endpoint is missing). */
const LATENCY_MS_SQL = `(julianday(o.end_time) - julianday(o.start_time)) * 86400000.0`;

/**
 * pNN percentile over a set of numeric window rows. `p` is a fraction (0-1).
 * Must sit inside an aggregate over the window results. Returns NULL when the
 * percentile lands on no row (empty set).
 */
const percentileSql = (p: number, value: string) =>
  `MAX(CASE WHEN rn = MAX(1, CAST(cnt * ${p} AS INTEGER)) THEN ${value} END)`;

/**
 * Normalize an ISO-8601 instant to the SQLite TEXT timestamp format used by the
 * telemetry store ("YYYY-MM-DD HH:MM:SS.sss"), so range params compare correctly.
 */
function toSqliteTime(value: string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").replace("Z", "");
}

app.get("/api/public/dashboard", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const db = getTelemetryDB();

  // Optional time range (ISO instants). When omitted, stats cover all time.
  const from = toSqliteTime(c.req.query("from") ?? "");
  const to = toSqliteTime(c.req.query("to") ?? "");

  // Builds a bounded time-window filter on a timestamp column plus the matching
  // bind params. `alias` prefixes the column when the query joins other tables.
  const timeFilter = (column: string, alias?: string) => {
    const col = alias ? `${alias}.${column}` : column;
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (from) {
      clauses.push(`${col} >= @from`);
      params.from = from;
    }
    if (to) {
      clauses.push(`${col} <= @to`);
      params.to = to;
    }
    return { sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", params };
  };

  try {
    const traceTime = timeFilter("timestamp");
    const obsTime = timeFilter("start_time");
    // Same window but with the `o` alias used by the imported cache SQL constants.
    const obsTimeO = timeFilter("start_time", "o");
    // trace_metrics has no timestamp column, so window it via the parent trace.
    const metricTime = timeFilter("timestamp", "t");
    const scoreTime = timeFilter("timestamp");

    const [
      traceCount,
      observationCount,
      generationCount,
      scoreCount,
      costRows,
      tokenRows,
      userRows,
      latencySummary,
      errorCount,
    ] = await Promise.all([
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM traces WHERE project_id = @projectId AND is_deleted = 0${traceTime.sql}`,
        params: { projectId, ...traceTime.params },
      }),
      db.query<{ count: number }>({
        query: `SELECT COALESCE(SUM(tm.obs_count), 0) as count
                FROM trace_metrics tm
                JOIN traces t ON t.project_id = tm.project_id AND t.id = tm.trace_id
                WHERE tm.project_id = @projectId AND t.is_deleted = 0${metricTime.sql}`,
        params: { projectId, ...metricTime.params },
      }),
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM observations WHERE project_id = @projectId AND is_deleted = 0 AND type = 'GENERATION'${obsTime.sql}`,
        params: { projectId, ...obsTime.params },
      }),
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM scores WHERE project_id = @projectId AND is_deleted = 0${scoreTime.sql}`,
        params: { projectId, ...scoreTime.params },
      }),
      db.query<{ total: number | null }>({
        query: `SELECT COALESCE(SUM(tm.total_cost), 0) as total
                FROM trace_metrics tm
                JOIN traces t ON t.project_id = tm.project_id AND t.id = tm.trace_id
                WHERE tm.project_id = @projectId AND t.is_deleted = 0${metricTime.sql}`,
        params: { projectId, ...metricTime.params },
      }),
      db.query<{
        total: number | null;
        input: number | null;
        output: number | null;
        cached: number | null;
        gross: number | null;
      }>({
        query: `SELECT COALESCE(SUM(tm.total_tokens), 0) as total,
                       COALESCE(SUM(tm.input_tokens), 0) as input,
                       COALESCE(SUM(tm.output_tokens), 0) as output,
                       COALESCE(SUM(tm.cached_tokens), 0) as cached,
                       COALESCE(SUM(tm.gross_input_tokens), 0) as gross
                FROM trace_metrics tm
                JOIN traces t ON t.project_id = tm.project_id AND t.id = tm.trace_id
                WHERE tm.project_id = @projectId AND t.is_deleted = 0${metricTime.sql}`,
        params: { projectId, ...metricTime.params },
      }),
      db.query<{ count: number }>({
        query: `SELECT COUNT(DISTINCT user_id) as count FROM traces WHERE project_id = @projectId AND is_deleted = 0 AND user_id IS NOT NULL${traceTime.sql}`,
        params: { projectId, ...traceTime.params },
      }),
      // Overall generation latency percentiles (p50 / p95 / avg) via window fns.
      db.query<{ avg: number | null; p50: number | null; p95: number | null }>({
        query: `
          WITH d AS (
            SELECT ${LATENCY_MS_SQL} AS ms,
                   ROW_NUMBER() OVER (ORDER BY ${LATENCY_MS_SQL}) AS rn,
                   COUNT(*) OVER () AS cnt
            FROM observations o
            WHERE o.project_id = @projectId AND o.is_deleted = 0 AND o.type = 'GENERATION'
              AND o.end_time IS NOT NULL AND o.start_time IS NOT NULL${obsTimeO.sql}
          )
          SELECT AVG(ms) as avg,
                 ${percentileSql(0.5, "ms")} as p50,
                 ${percentileSql(0.95, "ms")} as p95
          FROM d
        `,
        params: { projectId, ...obsTimeO.params },
      }),
      db.query<{ count: number }>({
        query: `SELECT COUNT(*) as count FROM observations WHERE project_id = @projectId AND is_deleted = 0 AND level = 'ERROR'${obsTime.sql}`,
        params: { projectId, ...obsTime.params },
      }),
    ]);

    // Daily time series over the selected window. Each metric series is merged
    // into one bucket per day. Timestamps are "YYYY-MM-DD HH:MM:SS.sss" TEXT.
    const [dailyTraces, dailyObs, dailyLatency, dailyErrors, dailyCache, dailyScores] =
      await Promise.all([
        db.query<{ day: string; count: number }>({
          query: `
            SELECT date(timestamp) as day, COUNT(*) as count
            FROM traces
            WHERE project_id = @projectId AND is_deleted = 0${traceTime.sql}
            GROUP BY day ORDER BY day ASC
          `,
          params: { projectId, ...traceTime.params },
        }),
        db.query<{ day: string; count: number; tokens: number | null }>({
          query: `
            SELECT date(start_time) as day, COUNT(*) as count,
                   COALESCE(SUM(COALESCE(json_extract(usage_details, '$.total'),
                       json_extract(usage_details, '$.input') + json_extract(usage_details, '$.output'), 0)), 0) as tokens
            FROM observations
            WHERE project_id = @projectId AND is_deleted = 0${obsTime.sql}
            GROUP BY day ORDER BY day ASC
          `,
          params: { projectId, ...obsTime.params },
        }),
        db.query<{ day: string; avg: number | null; p95: number | null }>({
          query: `
            WITH d AS (
              SELECT date(o.start_time) AS day, ${LATENCY_MS_SQL} AS ms,
                     ROW_NUMBER() OVER (PARTITION BY date(o.start_time) ORDER BY ${LATENCY_MS_SQL}) AS rn,
                     COUNT(*) OVER (PARTITION BY date(o.start_time)) AS cnt
              FROM observations o
              WHERE o.project_id = @projectId AND o.is_deleted = 0 AND o.type = 'GENERATION'
                AND o.end_time IS NOT NULL AND o.start_time IS NOT NULL${obsTimeO.sql}
            )
            SELECT day, AVG(ms) as avg, ${percentileSql(0.95, "ms")} as p95
            FROM d GROUP BY day
          `,
          params: { projectId, ...obsTimeO.params },
        }),
        db.query<{ day: string; count: number }>({
          query: `
            SELECT date(start_time) as day, COUNT(*) as count
            FROM observations
            WHERE project_id = @projectId AND is_deleted = 0 AND level = 'ERROR'${obsTime.sql}
            GROUP BY day ORDER BY day ASC
          `,
          params: { projectId, ...obsTime.params },
        }),
        db.query<{ day: string; cached: number | null; gross: number | null }>({
          query: `
            SELECT date(o.start_time) as day,
                   ${TRACE_METRICS_CACHED_TOKENS_SQL} as cached,
                   ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL} as gross
            FROM observations o
            WHERE o.project_id = @projectId AND o.is_deleted = 0${obsTimeO.sql}
            GROUP BY day ORDER BY day ASC
          `,
          params: { projectId, ...obsTimeO.params },
        }),
        db.query<{ day: string; avg: number | null }>({
          query: `
            SELECT date(timestamp) as day, AVG(value) as avg
            FROM scores
            WHERE project_id = @projectId AND is_deleted = 0 AND value IS NOT NULL${scoreTime.sql}
            GROUP BY day ORDER BY day ASC
          `,
          params: { projectId, ...scoreTime.params },
        }),
      ]);

    // Merge all daily series into one bucket per day.
    const byDay = new Map<string, DailyBucket>();
    const dayBucket = (day: string): DailyBucket => {
      let b = byDay.get(day);
      if (!b) {
        b = {
          date: day,
          traces: 0,
          observations: 0,
          tokens: 0,
          avgLatencyMs: 0,
          p95LatencyMs: 0,
          errors: 0,
          cacheHitRate: 0,
          avgScore: null,
        };
        byDay.set(day, b);
      }
      return b;
    };
    for (const r of dailyTraces) dayBucket(r.day).traces = Number(r.count);
    for (const r of dailyObs) {
      const b = dayBucket(r.day);
      b.observations = Number(r.count);
      b.tokens = Number(r.tokens ?? 0);
    }
    for (const r of dailyLatency) {
      const b = dayBucket(r.day);
      b.avgLatencyMs = Math.round(Number(r.avg ?? 0));
      b.p95LatencyMs = Math.round(Number(r.p95 ?? 0));
    }
    for (const r of dailyErrors) dayBucket(r.day).errors = Number(r.count);
    for (const r of dailyCache) {
      const cached = Number(r.cached ?? 0);
      const gross = Number(r.gross ?? 0);
      dayBucket(r.day).cacheHitRate = gross > 0 ? cached / gross : 0;
    }
    for (const r of dailyScores) {
      dayBucket(r.day).avgScore = r.avg === null ? null : Number(r.avg);
    }

    const daily = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Per-model breakdown (tokens + latency percentiles) and observation level mix.
    const [modelTokenRows, modelLatencyRows, levelRows] = await Promise.all([
      db.query<{ model: string | null; observations: number; tokens: number | null }>({
        query: `
          SELECT model, COUNT(*) as observations,
                 COALESCE(SUM(COALESCE(json_extract(usage_details, '$.total'), json_extract(usage_details, '$.input') + json_extract(usage_details, '$.output'), 0)), 0) as tokens
          FROM observations
          WHERE project_id = @projectId AND is_deleted = 0 AND type = 'GENERATION'${obsTime.sql}
          GROUP BY model ORDER BY tokens DESC LIMIT 6
        `,
        params: { projectId, ...obsTime.params },
      }),
      db.query<{
        model: string | null;
        avg: number | null;
        p50: number | null;
        p95: number | null;
      }>({
        query: `
            WITH d AS (
              SELECT o.model AS model, ${LATENCY_MS_SQL} AS ms,
                     ROW_NUMBER() OVER (PARTITION BY o.model ORDER BY ${LATENCY_MS_SQL}) AS rn,
                     COUNT(*) OVER (PARTITION BY o.model) AS cnt
              FROM observations o
              WHERE o.project_id = @projectId AND o.is_deleted = 0 AND o.type = 'GENERATION'
                AND o.end_time IS NOT NULL AND o.start_time IS NOT NULL${obsTimeO.sql}
            )
            SELECT model, AVG(ms) as avg,
                   ${percentileSql(0.5, "ms")} as p50,
                   ${percentileSql(0.95, "ms")} as p95
            FROM d GROUP BY model
          `,
        params: { projectId, ...obsTimeO.params },
      }),
      db.query<{ level: string | null; count: number }>({
        query: `
          SELECT level, COUNT(*) as count FROM observations
          WHERE project_id = @projectId AND is_deleted = 0${obsTime.sql}
          GROUP BY level ORDER BY count DESC
        `,
        params: { projectId, ...obsTime.params },
      }),
    ]);

    const latencyByModel = new Map(modelLatencyRows.map((r) => [r.model, r]));
    const byModel: ModelBucket[] = modelTokenRows.map((r) => {
      const lat = latencyByModel.get(r.model);
      return {
        model: r.model ?? "(unknown)",
        observations: Number(r.observations),
        tokens: Number(r.tokens ?? 0),
        avgLatencyMs: Math.round(Number(lat?.avg ?? 0)),
        p50LatencyMs: Math.round(Number(lat?.p50 ?? 0)),
        p95LatencyMs: Math.round(Number(lat?.p95 ?? 0)),
      };
    });
    const levels: LevelBucket[] = levelRows.map((r) => ({
      level: r.level ?? "DEFAULT",
      count: Number(r.count),
    }));

    // Top users by token consumption and the most recent error observations.
    const [topUserRows, recentErrorRows] = await Promise.all([
      db.query<{ userId: string; traces: number; tokens: number | null }>({
        query: `
          SELECT t.user_id as userId, COUNT(DISTINCT t.id) as traces,
                 COALESCE(SUM(tm.total_tokens), 0) as tokens
          FROM traces t
          JOIN trace_metrics tm ON tm.project_id = t.project_id AND tm.trace_id = t.id
          WHERE t.project_id = @projectId AND t.is_deleted = 0 AND t.user_id IS NOT NULL${metricTime.sql}
          GROUP BY t.user_id ORDER BY tokens DESC LIMIT 6
        `,
        params: { projectId, ...metricTime.params },
      }),
      db.query<{
        id: string;
        name: string | null;
        type: string | null;
        start_time: string | null;
        status_message: string | null;
        trace_id: string | null;
        model: string | null;
      }>({
        query: `
          SELECT id, name, type, start_time, status_message, trace_id, model
          FROM observations
          WHERE project_id = @projectId AND is_deleted = 0 AND level = 'ERROR'${obsTime.sql}
          ORDER BY start_time DESC LIMIT 8
        `,
        params: { projectId, ...obsTime.params },
      }),
    ]);

    const topUsers: UserBucket[] = topUserRows.map((r) => ({
      userId: r.userId,
      traces: Number(r.traces),
      tokens: Number(r.tokens ?? 0),
    }));
    const recentErrors: RecentError[] = recentErrorRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      startTime: r.start_time,
      statusMessage: r.status_message,
      traceId: r.trace_id,
      model: r.model,
    }));

    // Cache hit rate = cached read tokens / gross input tokens. The materialized
    // `gross_input_tokens` already resolves the per-provider `input` convention
    // (gross for Anthropic, net+cache for OpenAI/OTLP), so it is the correct
    // denominator — adding cached onto `input` again would double-count.
    const totalTokens = Number(tokenRows[0]?.total ?? 0);
    const totalCachedTokens = Number(tokenRows[0]?.cached ?? 0);
    const grossInput = Number(tokenRows[0]?.gross ?? 0);
    const cacheHitRate = grossInput > 0 ? totalCachedTokens / grossInput : 0;
    const totalObservations = Number(observationCount[0]?.count ?? 0);
    const totalErrors = Number(errorCount[0]?.count ?? 0);

    return c.json({
      summary: {
        totalTraces: Number(traceCount[0]?.count ?? 0),
        totalObservations,
        totalGenerations: Number(generationCount[0]?.count ?? 0),
        totalScores: Number(scoreCount[0]?.count ?? 0),
        totalCost: Number(costRows[0]?.total ?? 0),
        totalTokens,
        inputTokens: Number(tokenRows[0]?.input ?? 0),
        outputTokens: Number(tokenRows[0]?.output ?? 0),
        totalCachedTokens,
        cacheHitRate,
        totalUsers: Number(userRows[0]?.count ?? 0),
        avgLatencyMs: Math.round(Number(latencySummary[0]?.avg ?? 0)),
        p50LatencyMs: Math.round(Number(latencySummary[0]?.p50 ?? 0)),
        p95LatencyMs: Math.round(Number(latencySummary[0]?.p95 ?? 0)),
        errorCount: totalErrors,
        errorRate: totalObservations > 0 ? totalErrors / totalObservations : 0,
      },
      daily,
      byModel,
      levels,
      topUsers,
      recentErrors,
    });
  } catch (error) {
    logger.error("[lite-server] dashboard query failed", error);
    return c.json(
      {
        summary: {
          totalTraces: 0,
          totalObservations: 0,
          totalGenerations: 0,
          totalScores: 0,
          totalCost: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCachedTokens: 0,
          cacheHitRate: 0,
          totalUsers: 0,
          avgLatencyMs: 0,
          p50LatencyMs: 0,
          p95LatencyMs: 0,
          errorCount: 0,
          errorRate: 0,
        },
        daily: [],
        byModel: [],
        levels: [],
        topUsers: [],
        recentErrors: [],
      },
      200,
    );
  }
});

export default app;
