/**
 * Dashboard aggregation built on the materialized daily rollups.
 *
 * A request window is split into:
 *   - full days  → answered from daily_stats / daily_model_stats (~1 row per
 *     day per project, regardless of raw data volume);
 *   - edge days  → partial days at the window boundaries, computed live but
 *     bounded to < 24h each, so they stay index-cheap.
 *
 * Summary token/cost figures keep coming from trace_metrics (windowed via its
 * own timestamp column — no traces JOIN anymore). Percentiles are recovered
 * from the merged latency histograms (see stats/histogram.ts).
 */

import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import {
  accumulateDayStats,
  computeRangeModelStats,
  computeRangeStats,
  type DayStats,
  loadMaterializedDays,
  type ModelDayStats,
} from "@peri-fuse/shared/src/server/stats/daily-stats";
import {
  LATENCY_BUCKET_COUNT,
  mergeHistograms,
  percentileFromHistogram,
} from "@peri-fuse/shared/src/server/stats/histogram";

export type DashboardWindow = {
  /** SQLite TEXT timestamp, inclusive lower bound; null = unbounded. */
  from: string | null;
  /** SQLite TEXT timestamp, inclusive upper bound; null = unbounded. */
  to: string | null;
};

type EdgeRange = { from: string | null; toExclusive: string | null; day: string };

/**
 * Decompose the window into materialized day bounds plus live edge ranges.
 * `to` is treated inclusively by shifting it 1ms forward (timestamp TEXT
 * resolution is milliseconds).
 */
export function splitWindow(window: DashboardWindow): {
  matFromDay: string | null;
  matToDay: string | null;
  edges: EdgeRange[];
} {
  const { from, to } = window;
  const toExclusive = to ? addMillis(to, 1) : null;

  const fromDay = from ? from.slice(0, 10) : null;
  const toDay = toExclusive ? toExclusive.slice(0, 10) : null;

  const edges: EdgeRange[] = [];
  let matFromDay = fromDay;
  let matToDay = toDay;

  if (from && fromDay && from > dayStartTs(fromDay)) {
    // Leading partial day — the materialized rollup would over-count it.
    edges.push({ from, toExclusive: dayEndTs(fromDay), day: fromDay });
    matFromDay = nextDay(fromDay);
  }
  if (toExclusive && toDay && toExclusive < dayEndTs(toDay)) {
    // Trailing partial day.
    edges.push({ from: dayStartTs(toDay), toExclusive, day: toDay });
    if (matToDay) matToDay = prevDay(toDay);
  }

  // Merge edges that fall on the same day (window shorter than one day).
  if (edges.length === 2 && edges[0].day === edges[1].day) {
    edges.splice(0, 2, {
      from: edges[0].from,
      toExclusive: edges[1].toExclusive,
      day: edges[0].day,
    });
  }
  for (const e of edges) {
    if (e.toExclusive && e.from && e.toExclusive <= e.from) e.toExclusive = e.from;
  }

  // Empty materialized range when bounds crossed.
  if (matFromDay && matToDay && matFromDay > matToDay) {
    matFromDay = null;
    matToDay = null;
    // Signal "no materialized rows" via a sentinel pair the loader skips.
    return { matFromDay: null, matToDay: null, edges: collapseEdges(edges) };
  }
  return { matFromDay, matToDay, edges: collapseEdges(edges) };
}

function collapseEdges(edges: EdgeRange[]): EdgeRange[] {
  return edges.filter((e) => !(e.from && e.toExclusive && e.toExclusive <= e.from));
}

const dayStartTs = (day: string) => `${day} 00:00:00.000`;
const dayEndTs = (day: string) => dayStartTs(nextDay(day));

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Add milliseconds to a "YYYY-MM-DD HH:MM:SS.sss" timestamp string. */
function addMillis(ts: string, ms: number): string {
  const d = new Date(`${ts.slice(0, 10)}T${ts.slice(11).replace(" ", "")}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  d.setTime(d.getTime() + ms);
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export type DashboardBody = {
  summary: {
    totalTraces: number;
    totalObservations: number;
    totalGenerations: number;
    totalScores: number;
    totalCost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalCachedTokens: number;
    cacheHitRate: number;
    totalUsers: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    errorCount: number;
    errorRate: number;
  };
  daily: Array<{
    date: string;
    traces: number;
    observations: number;
    tokens: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    errors: number;
    cacheHitRate: number;
    avgScore: number | null;
  }>;
  byModel: Array<{
    model: string;
    observations: number;
    tokens: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  }>;
  levels: Array<{ level: string; count: number }>;
  topUsers: Array<{ userId: string; traces: number; tokens: number }>;
  recentErrors: Array<{
    id: string;
    name: string | null;
    type: string | null;
    startTime: string | null;
    statusMessage: string | null;
    traceId: string | null;
    model: string | null;
  }>;
};

/** Empty response (kept identical to the legacy error fallback). */
export function emptyDashboardBody(): DashboardBody {
  return {
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
  };
}

/** Build the full dashboard payload for a project window. */
export async function buildDashboard(
  projectId: string,
  window: DashboardWindow,
): Promise<DashboardBody> {
  const { from, to } = window;
  const parts = splitWindow(window);

  // ---- Materialized full days ---------------------------------------------
  const materialized =
    parts.matFromDay || parts.matToDay || (!from && !to)
      ? await loadMaterializedDays(projectId, parts.matFromDay, parts.matToDay)
      : { days: [], models: new Map<string, ModelDayStats[]>() };

  // ---- Live edge days -------------------------------------------------------
  const edgeDays: DayStats[] = [];
  const edgeModelsByDay = new Map<string, ModelDayStats[]>();
  await Promise.all(
    parts.edges.map(async (edge) => {
      if (edge.from && edge.toExclusive && edge.toExclusive <= edge.from) return;
      const [stats, models] = await Promise.all([
        computeRangeStats(projectId, edge.from, edge.toExclusive),
        computeRangeModelStats(projectId, edge.from, edge.toExclusive),
      ]);
      stats.day = edge.day;
      edgeDays.push(stats);
      edgeModelsByDay.set(edge.day, models);
    }),
  );

  // ---- Merge into per-day buckets ------------------------------------------
  const byDay = new Map<string, DayStats>();
  const modelsByDay = new Map<string, ModelDayStats[]>();
  for (const d of materialized.days) {
    byDay.set(d.day, d);
  }
  for (const [day, models] of materialized.models) {
    modelsByDay.set(day, models);
  }
  for (const d of edgeDays) {
    const existing = byDay.get(d.day);
    if (existing) accumulateDayStats(existing, d);
    else byDay.set(d.day, d);
    const models = edgeModelsByDay.get(d.day) ?? [];
    modelsByDay.set(d.day, [...(modelsByDay.get(d.day) ?? []), ...models]);
  }

  // ---- Window-wide accumulator ----------------------------------------------
  const acc: DayStats = {
    day: "",
    traces: 0,
    userIds: [],
    observations: 0,
    generations: 0,
    errors: 0,
    warnings: 0,
    debugs: 0,
    tokens: 0,
    cachedTokens: 0,
    grossInputTokens: 0,
    scoresCount: 0,
    scoresValCount: 0,
    scoreSum: 0,
    latCount: 0,
    latSumMs: 0,
    latHist: new Array<number>(LATENCY_BUCKET_COUNT).fill(0),
  };
  for (const d of byDay.values()) accumulateDayStats(acc, d);

  // Model rollup across the whole window.
  const modelAgg = new Map<
    string,
    { observations: number; tokens: number; latCount: number; latSumMs: number; latHist: number[] }
  >();
  for (const models of modelsByDay.values()) {
    for (const m of models) {
      const cur = modelAgg.get(m.model) ?? {
        observations: 0,
        tokens: 0,
        latCount: 0,
        latSumMs: 0,
        latHist: new Array<number>(LATENCY_BUCKET_COUNT).fill(0),
      };
      cur.observations += m.observations;
      cur.tokens += m.tokens;
      cur.latCount += m.latCount;
      cur.latSumMs += m.latSumMs;
      cur.latHist = mergeHistograms(cur.latHist, m.latHist);
      modelAgg.set(m.model, cur);
    }
  }

  // ---- trace_metrics-backed figures (no traces JOIN) ------------------------
  const db = getTelemetryDB();
  const metricWhere = ["tm.project_id = @projectId"];
  const metricParams: Record<string, unknown> = { projectId };
  if (from) {
    metricWhere.push("tm.timestamp >= @from");
    metricParams.from = from;
  }
  if (to) {
    metricWhere.push("tm.timestamp <= @to");
    metricParams.to = to;
  }
  const [metricsRows, topUserRows, recentErrorRows] = await Promise.all([
    db.query<{
      obsCount: number | null;
      totalCost: number | null;
      totalTokens: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedTokens: number | null;
      grossTokens: number | null;
    }>({
      query: `SELECT COALESCE(SUM(tm.obs_count), 0) as obsCount,
                     COALESCE(SUM(tm.total_cost), 0) as totalCost,
                     COALESCE(SUM(tm.total_tokens), 0) as totalTokens,
                     COALESCE(SUM(tm.input_tokens), 0) as inputTokens,
                     COALESCE(SUM(tm.output_tokens), 0) as outputTokens,
                     COALESCE(SUM(tm.cached_tokens), 0) as cachedTokens,
                     COALESCE(SUM(tm.gross_input_tokens), 0) as grossTokens
              FROM trace_metrics tm
              WHERE ${metricWhere.join(" AND ")}`,
      params: metricParams,
    }),
    db.query<{ userId: string; traces: number; tokens: number | null }>({
      query: `
        SELECT tm.user_id as userId, COUNT(DISTINCT tm.trace_id) as traces,
               COALESCE(SUM(tm.total_tokens), 0) as tokens
        FROM trace_metrics tm
        WHERE ${metricWhere.join(" AND ")} AND tm.user_id IS NOT NULL
        GROUP BY tm.user_id ORDER BY tokens DESC LIMIT 6
      `,
      params: metricParams,
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
        WHERE project_id = @projectId AND is_deleted = 0 AND level = 'ERROR'
          ${from ? "AND start_time >= @from" : ""} ${to ? "AND start_time <= @to" : ""}
        ORDER BY start_time DESC LIMIT 8
      `,
      params: { projectId, ...(from ? { from } : {}), ...(to ? { to } : {}) },
    }),
  ]);

  const metrics = metricsRows[0];
  const totalTokens = Number(metrics?.totalTokens ?? 0);
  const totalCachedTokens = Number(metrics?.cachedTokens ?? 0);
  const grossInput = Number(metrics?.grossTokens ?? 0);
  const cacheHitRate = grossInput > 0 ? totalCachedTokens / grossInput : 0;
  const totalObservations = Number(metrics?.obsCount ?? 0);
  const totalErrors = acc.errors;

  // ---- Assemble body ---------------------------------------------------------
  // Empty edge/refresh days carry no activity — the legacy GROUP BY-based
  // dashboard never surfaced them, so drop them here too.
  const daily = Array.from(byDay.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      date: d.day,
      traces: d.traces,
      observations: d.observations,
      tokens: d.tokens,
      avgLatencyMs: d.latCount > 0 ? Math.round(d.latSumMs / d.latCount) : 0,
      p95LatencyMs: Math.round(percentileFromHistogram(d.latHist, d.latCount, 0.95) ?? 0),
      errors: d.errors,
      cacheHitRate: d.grossInputTokens > 0 ? d.cachedTokens / d.grossInputTokens : 0,
      avgScore: d.scoresValCount > 0 ? d.scoreSum / d.scoresValCount : null,
    }))
    .filter(
      (d) =>
        d.traces > 0 || d.observations > 0 || d.tokens > 0 || d.errors > 0 || d.avgScore !== null,
    );

  const byModel = Array.from(modelAgg.entries())
    .map(([model, m]) => ({
      model: model === "" ? "(unknown)" : model,
      observations: m.observations,
      tokens: m.tokens,
      avgLatencyMs: m.latCount > 0 ? Math.round(m.latSumMs / m.latCount) : 0,
      p50LatencyMs: Math.round(percentileFromHistogram(m.latHist, m.latCount, 0.5) ?? 0),
      p95LatencyMs: Math.round(percentileFromHistogram(m.latHist, m.latCount, 0.95) ?? 0),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6);

  const levelCounts: Array<[string, number]> = [
    ["DEFAULT", acc.observations - acc.errors - acc.warnings - acc.debugs],
    ["ERROR", acc.errors],
    ["WARNING", acc.warnings],
    ["DEBUG", acc.debugs],
  ];
  const levels = levelCounts
    .filter(([, count]) => count > 0)
    .map(([level, count]) => ({ level, count }))
    .sort((a, b) => b.count - a.count);

  return {
    summary: {
      totalTraces: acc.traces,
      totalObservations,
      totalGenerations: acc.generations,
      totalScores: acc.scoresCount,
      totalCost: Number(metrics?.totalCost ?? 0),
      totalTokens,
      inputTokens: Number(metrics?.inputTokens ?? 0),
      outputTokens: Number(metrics?.outputTokens ?? 0),
      totalCachedTokens,
      cacheHitRate,
      totalUsers: acc.userIds.length,
      avgLatencyMs: acc.latCount > 0 ? Math.round(acc.latSumMs / acc.latCount) : 0,
      p50LatencyMs: Math.round(percentileFromHistogram(acc.latHist, acc.latCount, 0.5) ?? 0),
      p95LatencyMs: Math.round(percentileFromHistogram(acc.latHist, acc.latCount, 0.95) ?? 0),
      errorCount: totalErrors,
      errorRate: totalObservations > 0 ? totalErrors / totalObservations : 0,
    },
    daily,
    byModel,
    levels,
    topUsers: topUserRows.map((r) => ({
      userId: r.userId,
      traces: Number(r.traces),
      tokens: Number(r.tokens ?? 0),
    })),
    recentErrors: recentErrorRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      startTime: r.start_time,
      statusMessage: r.status_message,
      traceId: r.trace_id,
      model: r.model,
    })),
  };
}
