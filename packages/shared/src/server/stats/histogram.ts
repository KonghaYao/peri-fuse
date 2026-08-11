/**
 * Latency histogram utilities for materialized daily stats.
 *
 * Exact streaming percentiles would require keeping every latency value; the
 * dashboard only needs a stable approximation, so latencies are bucketed into
 * fixed exponential buckets at aggregation time and percentiles are recovered
 * by linear interpolation inside the bucket that contains the target rank.
 */

/** Upper bounds (ms) of each bucket; the last bucket is open-ended. */
export const LATENCY_BUCKET_BOUNDS_MS = [
  100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
] as const;

/** Number of histogram buckets (bounds + 1 open-ended tail). */
export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_BOUNDS_MS.length + 1;

/**
 * SQL CASE expression mapping a latency-in-ms expression to its bucket index.
 * Used to build the per-bucket SUM(CASE ...) aggregates in one scan.
 */
export function latencyBucketCaseSql(msExpr: string): string {
  const clauses = LATENCY_BUCKET_BOUNDS_MS.map((bound, i) => `WHEN ${msExpr} < ${bound} THEN ${i}`);
  return `(CASE ${clauses.join(" ")} ELSE ${LATENCY_BUCKET_BOUNDS_MS.length} END)`;
}

/** Sum two histograms element-wise (both must have LATENCY_BUCKET_COUNT slots). */
export function mergeHistograms(a: number[], b: number[]): number[] {
  const out = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) {
    out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  }
  return out;
}

/**
 * Approximate percentile (p in [0,1]) from a histogram with `total` samples.
 * Linear interpolation within the bucket holding the target rank. Returns
 * null when there are no samples.
 */
export function percentileFromHistogram(hist: number[], total: number, p: number): number | null {
  if (total <= 0) return null;
  const target = Math.max(1, Math.ceil(total * p));
  let cumulative = 0;
  for (let i = 0; i < hist.length; i++) {
    const count = hist[i] ?? 0;
    if (count === 0) continue;
    if (cumulative + count >= target) {
      const lower = i === 0 ? 0 : LATENCY_BUCKET_BOUNDS_MS[i - 1];
      const upper =
        i < LATENCY_BUCKET_BOUNDS_MS.length
          ? LATENCY_BUCKET_BOUNDS_MS[i]
          : LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1] * 2;
      const frac = (target - cumulative) / count;
      return lower + (upper - lower) * frac;
    }
    cumulative += count;
  }
  return null;
}
