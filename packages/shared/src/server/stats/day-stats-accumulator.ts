/**
 * Aggregation-time accumulator for daily stats (user-dedup fast path).
 *
 * `buildDashboard` folds every materialized day and every live edge range into
 * one window total. Merging plain `DayStats` values is quadratic in the number
 * of distinct users, because `userIds` is an array and each merged part rescans
 * it (`Array.prototype.includes`). The accumulator carries the same counters but
 * keeps users in an insertion-ordered `Set`, so a part costs O(part.userIds) and
 * the distinct total is a `.size` read. Counts stay exact — no approximation —
 * and first-seen order (the order `users_json` persists) is preserved.
 *
 * The accumulator only exists while aggregating: `DayStats`, the dashboard
 * payload and the persisted `users_json` column keep their current shape.
 */

import type { DayStats } from "./daily-stats";
import { LATENCY_BUCKET_COUNT } from "./histogram";

/** `DayStats` whose user list is a dedupe set instead of an array. */
export type DayStatsAccumulator = Omit<DayStats, "userIds"> & {
  /** Insertion order equals first-seen order, matching array semantics. */
  userIds: Set<string>;
};

/** A part merged into an accumulator; arrays and sets both iterate the same way. */
export type DayStatsPart = DayStats | DayStatsAccumulator;

/** Zeroed day stats (shape mirrors an empty daily_stats row). */
export function emptyDayStats(day: string): DayStats {
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

/** Zeroed accumulator for one bucket key ("" for a window-wide total). */
export function createDayStatsAccumulator(day = ""): DayStatsAccumulator {
  return { ...emptyDayStats(day), userIds: new Set<string>() };
}

/** Accumulator seeded from a computed day, so parts merge into a copy of it. */
export function toDayStatsAccumulator(day: DayStats): DayStatsAccumulator {
  return { ...day, userIds: new Set(day.userIds), latHist: [...day.latHist] };
}

/**
 * Materialize an accumulator as a plain `DayStats`, in first-seen user order.
 * The result is a snapshot: later merges into `acc` do not change it, and the
 * accumulator keeps its set for further merging.
 */
export function finalizeDayStats(acc: DayStatsAccumulator): DayStats {
  return { ...acc, userIds: Array.from(acc.userIds), latHist: [...acc.latHist] };
}

/**
 * Merge another day's (or range's) stats into `acc` in place.
 *
 * An accumulator target dedupes through its user set, which is reused by every
 * part merged into it — merging `n` parts costs O(sum(part.userIds)) instead of
 * the O(users²) of rescanning a growing array. A plain `DayStats` target keeps
 * the original linear-scan behavior for existing callers.
 */
export function accumulateDayStats(acc: DayStatsAccumulator, part: DayStatsPart): void;
export function accumulateDayStats(acc: DayStats, part: DayStats): void;
export function accumulateDayStats(acc: DayStatsAccumulator | DayStats, part: DayStatsPart): void {
  acc.traces += part.traces;
  if (acc.userIds instanceof Set) {
    for (const u of part.userIds) acc.userIds.add(u);
  } else {
    for (const u of part.userIds) if (!acc.userIds.includes(u)) acc.userIds.push(u);
  }
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
