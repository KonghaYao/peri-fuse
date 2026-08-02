/**
 * Per-trace metric aggregation over raw SQLite observation/trace rows.
 *
 * Shared by the traces-metrics endpoint and the sessions endpoints. Mirrors
 * the aggregation the full-mode UI derives from ClickHouse
 * (`getTracesTableMetrics`) and the latency logic used by the trace-detail
 * route (lastEnd - firstStart, falling back to lastStart - firstStart when no
 * observation carries an end time).
 */

export type TraceMetricsRow = {
  id: string;
  latency: number | null;
  observationCount: number;
  level: string;
  errorCount: number;
  warningCount: number;
  debugCount: number;
  defaultCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  calculatedInputCost: number | null;
  calculatedOutputCost: number | null;
  calculatedTotalCost: number | null;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  input: unknown;
  output: unknown;
  metadata: unknown;
};

/**
 * Cache-related usage_details keys. `usage_details.input` is the NET input
 * (cache already subtracted), so the gross input for hit-rate computation is
 * net input + cache read + cache creation.
 */
const CACHE_READ_KEYS = ["input_cached_tokens", "input_cache_read"];
const CACHE_CREATION_KEYS = [
  "input_cache_creation",
  "input_cache_write",
  "input_cache_creation_5m",
  "input_cache_creation_1h",
];

/** Sum of cache-read (hit) tokens from a parsed usage map. */
export function sumCacheReadTokens(usage: Record<string, number>): number {
  return CACHE_READ_KEYS.reduce((acc, k) => acc + (usage[k] ?? 0), 0);
}

/** Sum of cache-creation/write tokens from a parsed usage map. */
export function sumCacheCreationTokens(usage: Record<string, number>): number {
  return CACHE_CREATION_KEYS.reduce((acc, k) => acc + (usage[k] ?? 0), 0);
}

/** Parse a JSON-object column (usage_details / cost_details) into numbers. */
export function parseJsonRecord(value: unknown): Record<string, number> {
  if (value === null || value === undefined) return {};
  let obj: unknown = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof obj !== "object" || obj === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const num = Number(v);
    if (v !== null && v !== undefined && !Number.isNaN(num)) out[k] = num;
  }
  return out;
}

/** Parse a JSON scalar/object column (input / output / metadata). */
export function parseJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** SQLite TEXT timestamp ("YYYY-MM-DD HH:MM:SS.sss") -> epoch ms, or null. */
export function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(`${String(value).replace(" ", "T")}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Aggregate per-trace metrics from raw observation rows plus the trace's own
 * input/output/metadata. `observations` are raw SQLite rows for a single trace.
 */
export function aggregateTraceMetrics(
  traceId: string,
  observations: Array<Record<string, unknown>>,
  traceIo: { input: unknown; output: unknown; metadata: unknown },
): TraceMetricsRow {
  const levelCounts = { ERROR: 0, WARNING: 0, DEBUG: 0, DEFAULT: 0 };
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let cacheCreationTokens = 0;
  let inputCost = 0;
  let outputCost = 0;
  let totalCost = 0;
  const usageDetails: Record<string, number> = {};
  const costDetails: Record<string, number> = {};
  const startTimes: number[] = [];
  const endTimes: number[] = [];

  for (const obs of observations) {
    const level = String(obs.level ?? "DEFAULT").toUpperCase();
    if (level in levelCounts) {
      levelCounts[level as keyof typeof levelCounts] += 1;
    } else {
      levelCounts.DEFAULT += 1;
    }

    const usage = parseJsonRecord(obs.usage_details);
    promptTokens += usage.input ?? 0;
    completionTokens += usage.output ?? 0;
    totalTokens += usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
    cachedTokens += sumCacheReadTokens(usage);
    cacheCreationTokens += sumCacheCreationTokens(usage);
    for (const [k, v] of Object.entries(usage)) {
      usageDetails[k] = (usageDetails[k] ?? 0) + v;
    }

    const cost = parseJsonRecord(obs.cost_details);
    inputCost += cost.input ?? 0;
    outputCost += cost.output ?? 0;
    const obsTotalCost =
      obs.total_cost !== null && obs.total_cost !== undefined
        ? Number(obs.total_cost)
        : (cost.total ?? 0);
    totalCost += Number.isNaN(obsTotalCost) ? 0 : obsTotalCost;
    for (const [k, v] of Object.entries(cost)) {
      costDetails[k] = (costDetails[k] ?? 0) + v;
    }

    const start = toMs(obs.start_time);
    if (start !== null) startTimes.push(start);
    const end = toMs(obs.end_time);
    if (end !== null) endTimes.push(end);
  }

  startTimes.sort((a, b) => a - b);
  endTimes.sort((a, b) => a - b);

  let latency: number | null = null;
  if (startTimes.length > 0) {
    if (endTimes.length > 0) {
      latency = (endTimes[endTimes.length - 1]! - startTimes[0]!) / 1000;
    } else if (startTimes.length > 1) {
      latency = (startTimes[startTimes.length - 1]! - startTimes[0]!) / 1000;
    }
  }

  const level =
    levelCounts.ERROR > 0
      ? "ERROR"
      : levelCounts.WARNING > 0
        ? "WARNING"
        : levelCounts.DEBUG > 0
          ? "DEBUG"
          : "DEFAULT";

  const fallbackTotal = inputCost + outputCost;
  const grossInput = promptTokens + cachedTokens + cacheCreationTokens;
  const cacheHitRate = grossInput > 0 ? cachedTokens / grossInput : 0;
  return {
    id: traceId,
    latency,
    observationCount: observations.length,
    level,
    errorCount: levelCounts.ERROR,
    warningCount: levelCounts.WARNING,
    debugCount: levelCounts.DEBUG,
    defaultCount: levelCounts.DEFAULT,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheHitRate,
    calculatedInputCost: inputCost > 0 ? inputCost : null,
    calculatedOutputCost: outputCost > 0 ? outputCost : null,
    calculatedTotalCost: totalCost > 0 ? totalCost : fallbackTotal > 0 ? fallbackTotal : null,
    usageDetails,
    costDetails,
    input: traceIo.input,
    output: traceIo.output,
    metadata: traceIo.metadata,
  };
}
