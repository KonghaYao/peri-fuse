/**
 * Materialized per-day dashboard stats.
 *
 * The dashboard used to run ~12 full-scan aggregates over observations on
 * every cache miss; with 30d windows covering the whole history that cost
 * grows linearly with data volume. Instead we maintain two small rollup
 * tables:
 *
 *   daily_stats(project_id, day)        — trace/observation/score counts,
 *                                         token sums, latency histogram,
 *                                         distinct user ids
 *   daily_model_stats(project_id, day, model)
 *                                       — per-model observation/token/latency
 *
 * Maintenance model (idempotent full recompute, no incremental counters —
 * merge-inserts and re-sent events must never double-count):
 *   - backfill: on boot, every (project, day) present in the raw tables but
 *     missing from daily_stats is recomputed once, yielding between days;
 *   - refresh: every REFRESH_INTERVAL_MS the last two days are recomputed to
 *     absorb late-arriving events;
 *   - on demand: recomputeDay()/recomputeRange() are exported for tests.
 *
 * Dashboard queries then read ~30 rollup rows per 30d window and only fall
 * back to raw scans for partial (edge) days, which stay index-bounded.
 */

import { getTelemetryDB } from "../adapters";
import {
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "../adapters/sqlite-telemetry-adapter";
import { logger } from "../logger";
import { LATENCY_BUCKET_COUNT, latencyBucketCaseSql } from "./histogram";

/** Generation latency in ms (NULL when either endpoint is missing). */
const LATENCY_MS_SQL = `(julianday(o.end_time) - julianday(o.start_time)) * 86400000.0`;

/** Bucket index for a generation latency, NULL for non-generation rows. */
const GUARDED_BUCKET_SQL = `(CASE WHEN o.type = 'GENERATION' AND o.end_time IS NOT NULL
  THEN ${latencyBucketCaseSql(LATENCY_MS_SQL)} END)`;

/**
 * Aggregate select-list shared by day recompute and edge-range scans.
 * One pass over observations yields counts, levels, token sums and the
 * latency histogram (previously 5+ separate scans with per-row JSON parses
 * repeated per query).
 */
function obsAggSelect(): string {
  const buckets = Array.from(
    { length: LATENCY_BUCKET_COUNT },
    (_, i) => `COALESCE(SUM(CASE WHEN ${GUARDED_BUCKET_SQL} = ${i} THEN 1 ELSE 0 END), 0) AS b${i}`,
  ).join(",\n    ");
  return `
    COUNT(*) AS observations,
    COALESCE(SUM(CASE WHEN o.type = 'GENERATION' THEN 1 ELSE 0 END), 0) AS generations,
    COALESCE(SUM(CASE WHEN o.level = 'ERROR' THEN 1 ELSE 0 END), 0) AS errors,
    COALESCE(SUM(CASE WHEN o.level = 'WARNING' THEN 1 ELSE 0 END), 0) AS warnings,
    COALESCE(SUM(CASE WHEN o.level = 'DEBUG' THEN 1 ELSE 0 END), 0) AS debugs,
    COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.total'),
        json_extract(o.usage_details, '$.input') + json_extract(o.usage_details, '$.output'), 0)), 0) AS tokens,
    ${TRACE_METRICS_CACHED_TOKENS_SQL} AS cached_tokens,
    ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL} AS gross_input_tokens,
    COALESCE(SUM(CASE WHEN o.type = 'GENERATION' AND o.end_time IS NOT NULL THEN 1 ELSE 0 END), 0) AS lat_count,
    COALESCE(SUM(CASE WHEN o.type = 'GENERATION' AND o.end_time IS NOT NULL
        THEN ${LATENCY_MS_SQL} ELSE 0 END), 0) AS lat_sum_ms,
    ${buckets}
  `;
}

type ObsAggRow = {
  observations: number;
  generations: number;
  errors: number;
  warnings: number;
  debugs: number;
  tokens: number;
  cached_tokens: number;
  gross_input_tokens: number;
  lat_count: number;
  lat_sum_ms: number;
} & Record<`b${number}`, number>;

/** One materialized day of stats (shape mirrors daily_stats columns). */
export type DayStats = {
  day: string;
  traces: number;
  userIds: string[];
  observations: number;
  generations: number;
  errors: number;
  warnings: number;
  debugs: number;
  tokens: number;
  cachedTokens: number;
  grossInputTokens: number;
  scoresCount: number;
  scoresValCount: number;
  scoreSum: number;
  latCount: number;
  latSumMs: number;
  latHist: number[];
};

export type ModelDayStats = {
  model: string;
  observations: number;
  tokens: number;
  latCount: number;
  latSumMs: number;
  latHist: number[];
};

type ModelAggRow = {
  model: string | null;
  observations: number;
  tokens: number;
  lat_count: number;
  lat_sum_ms: number;
} & Record<`b${number}`, number>;

function histFromRow(row: Record<string, unknown>): number[] {
  return Array.from({ length: LATENCY_BUCKET_COUNT }, (_, i) => Number(row[`b${i}`] ?? 0));
}

function emptyDayStats(day: string): DayStats {
  return {
    day,
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
}

/** Merge another day's (or range's) stats into `acc` in place. */
export function accumulateDayStats(acc: DayStats, part: DayStats): void {
  acc.traces += part.traces;
  for (const u of part.userIds) if (!acc.userIds.includes(u)) acc.userIds.push(u);
  acc.observations += part.observations;
  acc.generations += part.generations;
  acc.errors += part.errors;
  acc.warnings += part.warnings;
  acc.debugs += part.debugs;
  acc.tokens += part.tokens;
  acc.cachedTokens += part.cachedTokens;
  acc.grossInputTokens += part.grossInputTokens;
  acc.scoresCount += part.scoresCount;
  acc.scoresValCount += part.scoresValCount;
  acc.scoreSum += part.scoreSum;
  acc.latCount += part.latCount;
  acc.latSumMs += part.latSumMs;
  for (let i = 0; i < acc.latHist.length; i++) acc.latHist[i] += part.latHist[i] ?? 0;
}

/**
 * Compute stats for an arbitrary time range (half-open `[from, to)` in SQLite
 * TEXT timestamps; either bound may be null). Used for edge days that the
 * materialized rollup cannot cover and for tests.
 */
export async function computeRangeStats(
  projectId: string,
  from: string | null,
  to: string | null,
): Promise<DayStats> {
  const db = getTelemetryDB();
  const obsWhere = ["o.project_id = @projectId", "o.is_deleted = 0"];
  const traceWhere = ["project_id = @projectId", "is_deleted = 0"];
  const scoreWhere = ["project_id = @projectId", "is_deleted = 0"];
  const params: Record<string, unknown> = { projectId };
  if (from) {
    obsWhere.push("o.start_time >= @from");
    traceWhere.push("timestamp >= @from");
    scoreWhere.push("timestamp >= @from");
    params.from = from;
  }
  if (to) {
    obsWhere.push("o.start_time < @to");
    traceWhere.push("timestamp < @to");
    scoreWhere.push("timestamp < @to");
    params.to = to;
  }

  const [obsRows, traceRows, userRows, scoreRows] = await Promise.all([
    db.query<ObsAggRow>({
      query: `SELECT ${obsAggSelect()} FROM observations o WHERE ${obsWhere.join(" AND ")}`,
      params,
    }),
    db.query<{ traces: number }>({
      query: `SELECT COUNT(*) AS traces FROM traces WHERE ${traceWhere.join(" AND ")}`,
      params,
    }),
    db.query<{ user_id: string }>({
      query: `SELECT DISTINCT user_id FROM traces WHERE ${traceWhere.join(" AND ")} AND user_id IS NOT NULL`,
      params,
    }),
    db.query<{ cnt: number; val_cnt: number; val_sum: number }>({
      query: `SELECT COUNT(*) AS cnt,
                     COALESCE(SUM(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END), 0) AS val_cnt,
                     COALESCE(SUM(COALESCE(value, 0)), 0) AS val_sum
              FROM scores WHERE ${scoreWhere.join(" AND ")}`,
      params,
    }),
  ]);

  const obs = obsRows[0];
  const day = emptyDayStats("");
  if (obs) {
    day.observations = Number(obs.observations);
    day.generations = Number(obs.generations);
    day.errors = Number(obs.errors);
    day.warnings = Number(obs.warnings);
    day.debugs = Number(obs.debugs);
    day.tokens = Number(obs.tokens);
    day.cachedTokens = Number(obs.cached_tokens);
    day.grossInputTokens = Number(obs.gross_input_tokens);
    day.latCount = Number(obs.lat_count);
    day.latSumMs = Number(obs.lat_sum_ms);
    day.latHist = histFromRow(obs as unknown as Record<string, unknown>);
  }
  day.traces = Number(traceRows[0]?.traces ?? 0);
  day.userIds = userRows.map((r) => r.user_id);
  day.scoresCount = Number(scoreRows[0]?.cnt ?? 0);
  day.scoresValCount = Number(scoreRows[0]?.val_cnt ?? 0);
  day.scoreSum = Number(scoreRows[0]?.val_sum ?? 0);
  return day;
}

/** Per-model generation stats for a range (edge days / backfill). */
export async function computeRangeModelStats(
  projectId: string,
  from: string | null,
  to: string | null,
): Promise<ModelDayStats[]> {
  const db = getTelemetryDB();
  const where = ["o.project_id = @projectId", "o.is_deleted = 0", "o.type = 'GENERATION'"];
  const params: Record<string, unknown> = { projectId };
  if (from) {
    where.push("o.start_time >= @from");
    params.from = from;
  }
  if (to) {
    where.push("o.start_time < @to");
    params.to = to;
  }
  const rows = await db.query<ModelAggRow>({
    query: `
      SELECT COALESCE(o.model, '') AS model,
             COUNT(*) AS observations,
             COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.total'),
                 json_extract(o.usage_details, '$.input') + json_extract(o.usage_details, '$.output'), 0)), 0) AS tokens,
             COALESCE(SUM(CASE WHEN o.end_time IS NOT NULL THEN 1 ELSE 0 END), 0) AS lat_count,
             COALESCE(SUM(CASE WHEN o.end_time IS NOT NULL THEN ${LATENCY_MS_SQL} ELSE 0 END), 0) AS lat_sum_ms,
             ${Array.from(
               { length: LATENCY_BUCKET_COUNT },
               (_, i) =>
                 `COALESCE(SUM(CASE WHEN ${latencyBucketCaseSql(LATENCY_MS_SQL)} = ${i} AND o.end_time IS NOT NULL THEN 1 ELSE 0 END), 0) AS b${i}`,
             ).join(",\n             ")}
      FROM observations o
      WHERE ${where.join(" AND ")}
      GROUP BY COALESCE(o.model, '')
    `,
    params,
  });
  return rows.map((r) => ({
    model: r.model ?? "",
    observations: Number(r.observations),
    tokens: Number(r.tokens),
    latCount: Number(r.lat_count),
    latSumMs: Number(r.lat_sum_ms),
    latHist: histFromRow(r as unknown as Record<string, unknown>),
  }));
}

const dayStart = (day: string) => `${day} 00:00:00.000`;
const nextDayStart = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Recompute and upsert the rollup rows for one (project, day). */
export async function recomputeDay(projectId: string, day: string): Promise<void> {
  const db = getTelemetryDB();
  const from = dayStart(day);
  const to = dayStart(nextDayStart(day));
  const [stats, models] = await Promise.all([
    computeRangeStats(projectId, from, to),
    computeRangeModelStats(projectId, from, to),
  ]);

  await db.command({
    query: `
      INSERT OR REPLACE INTO daily_stats (
        project_id, day, traces, users_json, observations, generations, errors,
        warnings, debugs, tokens, cached_tokens, gross_input_tokens,
        scores_count, scores_val_count, score_sum, lat_count, lat_sum_ms,
        lat_hist, updated_at
      ) VALUES (
        @projectId, @day, @traces, @usersJson, @observations, @generations,
        @errors, @warnings, @debugs, @tokens, @cachedTokens, @grossInputTokens,
        @scoresCount, @scoresValCount, @scoreSum, @latCount, @latSumMs,
        @latHist, datetime('now')
      )
    `,
    params: {
      projectId,
      day,
      traces: stats.traces,
      usersJson: JSON.stringify(stats.userIds),
      observations: stats.observations,
      generations: stats.generations,
      errors: stats.errors,
      warnings: stats.warnings,
      debugs: stats.debugs,
      tokens: stats.tokens,
      cachedTokens: stats.cachedTokens,
      grossInputTokens: stats.grossInputTokens,
      scoresCount: stats.scoresCount,
      scoresValCount: stats.scoresValCount,
      scoreSum: stats.scoreSum,
      latCount: stats.latCount,
      latSumMs: stats.latSumMs,
      latHist: JSON.stringify(stats.latHist),
    },
  });

  // Replace the day's model rows wholesale so vanished models disappear too.
  await db.command({
    query: "DELETE FROM daily_model_stats WHERE project_id = @projectId AND day = @day",
    params: { projectId, day },
  });
  for (const m of models) {
    await db.command({
      query: `
        INSERT OR REPLACE INTO daily_model_stats (
          project_id, day, model, observations, tokens, lat_count, lat_sum_ms, lat_hist
        ) VALUES (@projectId, @day, @model, @observations, @tokens, @latCount, @latSumMs, @latHist)
      `,
      params: {
        projectId,
        day,
        model: m.model,
        observations: m.observations,
        tokens: m.tokens,
        latCount: m.latCount,
        latSumMs: m.latSumMs,
        latHist: JSON.stringify(m.latHist),
      },
    });
  }
}

/** Load materialized days in [fromDay, toDay] inclusive. */
export async function loadMaterializedDays(
  projectId: string,
  fromDay: string | null,
  toDay: string | null,
): Promise<{ days: DayStats[]; models: Map<string, ModelDayStats[]> }> {
  const db = getTelemetryDB();
  const where = ["project_id = @projectId"];
  const params: Record<string, unknown> = { projectId };
  if (fromDay) {
    where.push("day >= @fromDay");
    params.fromDay = fromDay;
  }
  if (toDay) {
    where.push("day <= @toDay");
    params.toDay = toDay;
  }
  const whereSql = where.join(" AND ");
  const [dayRows, modelRows] = await Promise.all([
    db.query<Record<string, unknown>>({
      query: `SELECT * FROM daily_stats WHERE ${whereSql} ORDER BY day ASC`,
      params,
    }),
    db.query<Record<string, unknown>>({
      query: `SELECT * FROM daily_model_stats WHERE ${whereSql} ORDER BY day ASC`,
      params,
    }),
  ]);

  const days: DayStats[] = dayRows.map((r) => ({
    day: String(r.day),
    traces: Number(r.traces ?? 0),
    userIds: parseJsonArray(String(r.users_json ?? "[]")),
    observations: Number(r.observations ?? 0),
    generations: Number(r.generations ?? 0),
    errors: Number(r.errors ?? 0),
    warnings: Number(r.warnings ?? 0),
    debugs: Number(r.debugs ?? 0),
    tokens: Number(r.tokens ?? 0),
    cachedTokens: Number(r.cached_tokens ?? 0),
    grossInputTokens: Number(r.gross_input_tokens ?? 0),
    scoresCount: Number(r.scores_count ?? 0),
    scoresValCount: Number(r.scores_val_count ?? 0),
    scoreSum: Number(r.score_sum ?? 0),
    latCount: Number(r.lat_count ?? 0),
    latSumMs: Number(r.lat_sum_ms ?? 0),
    latHist: parseNumberArray(String(r.lat_hist ?? "[]")),
  }));

  const models = new Map<string, ModelDayStats[]>();
  for (const r of modelRows) {
    const day = String(r.day);
    const list = models.get(day) ?? [];
    list.push({
      model: String(r.model ?? ""),
      observations: Number(r.observations ?? 0),
      tokens: Number(r.tokens ?? 0),
      latCount: Number(r.lat_count ?? 0),
      latSumMs: Number(r.lat_sum_ms ?? 0),
      latHist: parseNumberArray(String(r.lat_hist ?? "[]")),
    });
    models.set(day, list);
  }
  return { days, models };
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
    const out = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
    for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) out[i] = Number(v[i] ?? 0);
    return out;
  } catch {
    return new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  }
}

export { dayStart, nextDayStart };

/** Yield to the event loop so chunked maintenance never starves HTTP traffic. */
const yieldLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Recompute today + yesterday for every project (late-arriving events). */
export async function refreshRecentDays(): Promise<void> {
  const db = getTelemetryDB();
  const projects = await db.query<{ project_id: string }>({
    query: "SELECT DISTINCT project_id FROM traces",
    params: {},
  });
  const today = new Date().toISOString().slice(0, 10);
  const yesterdayDate = new Date(`${today}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const days = [today, yesterdayDate.toISOString().slice(0, 10)];
  for (const p of projects) {
    for (const day of days) {
      try {
        await recomputeDay(p.project_id, day);
      } catch (error) {
        logger.error("[daily-stats] refresh failed", error);
      }
    }
  }
}

/**
 * One-time backfill: recompute every (project, day) present in the raw tables
 * but missing from daily_stats. Runs chunked so startup never blocks.
 */
export async function backfillMissingDays(): Promise<number> {
  const db = getTelemetryDB();
  const [combos] = await Promise.all([
    db.query<{ project_id: string; day: string }>({
      query: `
        SELECT DISTINCT project_id, date(start_time) AS day FROM observations
        UNION
        SELECT DISTINCT project_id, date(timestamp) AS day FROM traces
        UNION
        SELECT DISTINCT project_id, date(timestamp) AS day FROM scores
      `,
      params: {},
    }),
  ]);
  const existing = await db.query<{ project_id: string; day: string }>({
    query: "SELECT project_id, day FROM daily_stats",
    params: {},
  });
  const have = new Set(existing.map((r) => `${r.project_id}|${r.day}`));
  const missing = combos.filter((c) => !have.has(`${c.project_id}|${c.day}`));
  if (missing.length > 0) {
    logger.info(`[daily-stats] Backfilling ${missing.length} missing day(s)…`);
  }
  let done = 0;
  for (const c of missing) {
    try {
      await recomputeDay(c.project_id, c.day);
      done++;
    } catch (error) {
      logger.error(`[daily-stats] Backfill failed for ${c.project_id} ${c.day}`, error);
    }
    await yieldLoop();
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
  let stopped = false;
  void backfillMissingDays().catch((e) => logger.error("[daily-stats] backfill error", e));
  const timer = setInterval(() => {
    if (stopped) return;
    void refreshRecentDays().catch((e) => logger.error("[daily-stats] refresh error", e));
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
