/**
 * §7.1 user dedup: merging day stats through a shared user set must reproduce
 * the legacy array-scan merge exactly — same `userIds` content AND first-seen
 * order, same counters — while scaling linearly with the merged user count.
 *
 * The pre-change implementation is kept verbatim in this file as the oracle.
 * `buildDashboard`'s merge order is replayed on both paths: materialized days
 * first, then edge days (the real handler pushes edges in completion order, so
 * order equivalence is asserted against a fixed, deterministic order here).
 */
import { describe, expect, it } from "vitest";
import type { DayStats } from "./daily-stats";
import {
  accumulateDayStats,
  createDayStatsAccumulator,
  type DayStatsAccumulator,
  finalizeDayStats,
  toDayStatsAccumulator,
} from "./day-stats-accumulator";
import { LATENCY_BUCKET_COUNT } from "./histogram";

// ---------------------------------------------------------------------------
// Oracle: verbatim copies of the implementation before the accumulator change.
// ---------------------------------------------------------------------------

function legacyEmptyDayStats(day: string): DayStats {
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

function legacyAccumulateDayStats(acc: DayStats, part: DayStats): void {
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type DayFixture = { day: string; materialized?: DayStats; edge?: DayStats };

let partTag = 0;

/** A day part with independently built fields (never uses the code under test). */
function makePart(day: string, users: string[]): DayStats {
  const tag = ++partTag;
  return {
    day,
    traces: tag,
    userIds: [...users],
    observations: tag * 2,
    generations: tag,
    errors: tag % 3,
    warnings: tag % 5,
    debugs: tag % 7,
    tokens: tag * 100,
    cachedTokens: tag * 10,
    grossInputTokens: tag * 1000,
    scoresCount: tag % 4,
    scoresValCount: tag % 2,
    scoreSum: tag / 8,
    latCount: tag * 3,
    latSumMs: tag * 123.5,
    latHist: Array.from({ length: LATENCY_BUCKET_COUNT }, (_, i) => (tag + i) % 9),
  };
}

/** Replay `buildDashboard`'s merge sequence with the legacy merge. */
function legacyAggregate(fixture: DayFixture[]): { days: DayStats[]; window: DayStats } {
  const byDay = new Map<string, DayStats>();
  for (const { day, materialized } of fixture) {
    if (materialized) byDay.set(day, structuredClone(materialized));
  }
  for (const { day, edge } of fixture) {
    if (!edge) continue;
    const existing = byDay.get(day);
    if (existing) legacyAccumulateDayStats(existing, edge);
    else byDay.set(day, structuredClone(edge));
  }
  const window = legacyEmptyDayStats("");
  for (const d of byDay.values()) legacyAccumulateDayStats(window, d);
  return { days: [...byDay.values()], window };
}

/** Replay the same sequence with accumulators (one set per day + one shared). */
function accumulatorAggregate(fixture: DayFixture[]): {
  days: DayStats[];
  window: DayStats;
  totalUsers: number;
} {
  const byDay = new Map<string, DayStatsAccumulator>();
  for (const { day, materialized } of fixture) {
    if (materialized) byDay.set(day, toDayStatsAccumulator(materialized));
  }
  for (const { day, edge } of fixture) {
    if (!edge) continue;
    const existing = byDay.get(day);
    if (existing) accumulateDayStats(existing, edge);
    else byDay.set(day, toDayStatsAccumulator(edge));
  }
  const window = createDayStatsAccumulator();
  for (const d of byDay.values()) accumulateDayStats(window, d);
  return {
    days: [...byDay.values()].map(finalizeDayStats),
    window: finalizeDayStats(window),
    totalUsers: window.userIds.size,
  };
}

/** Assert the accumulator path is field-for-field identical to the oracle. */
function expectSameAsLegacy(fixture: DayFixture[]): { legacy: DayStats; totalUsers: number } {
  const legacy = legacyAggregate(fixture);
  const next = accumulatorAggregate(fixture);
  expect(next.days).toEqual(legacy.days);
  expect(next.window).toEqual(legacy.window);
  // Restate the two properties the response depends on.
  expect(next.window.userIds).toEqual(legacy.window.userIds);
  expect(next.totalUsers).toBe(legacy.window.userIds.length);
  return { legacy: legacy.window, totalUsers: next.totalUsers };
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

describe("accumulator merge equivalence (§7.1)", () => {
  it("counts a user once while keeping first-seen order across days", () => {
    const fixture: DayFixture[] = [
      { day: "2026-01-01", materialized: makePart("2026-01-01", ["a", "b"]) },
      { day: "2026-01-02", materialized: makePart("2026-01-02", ["b", "c"]) },
      { day: "2026-01-03", materialized: makePart("2026-01-03", ["a", "c", "d"]) },
    ];
    const { legacy, totalUsers } = expectSameAsLegacy(fixture);
    expect(legacy.userIds).toEqual(["a", "b", "c", "d"]);
    expect(totalUsers).toBe(4);
  });

  it("dedupes within a day and across the window", () => {
    // Computed parts are always distinct internally (SELECT DISTINCT), so the
    // overlaps that matter are the ones across parts and across days.
    const fixture: DayFixture[] = [
      { day: "2026-02-01", materialized: makePart("2026-02-01", ["u1", "u2"]) },
      {
        day: "2026-02-01",
        edge: makePart("2026-02-01", ["u2", "u3", "u1"]),
      },
      { day: "2026-02-02", materialized: makePart("2026-02-02", ["u1", "u4"]) },
    ];
    const { legacy, totalUsers } = expectSameAsLegacy(fixture);
    expect(legacy.userIds).toEqual(["u1", "u2", "u3", "u4"]);
    expect(totalUsers).toBe(4);
  });

  it("merges a live edge part into the same day's materialized part", () => {
    const fixture: DayFixture[] = [
      {
        day: "2026-03-07",
        materialized: makePart("2026-03-07", ["edge-a", "shared"]),
        edge: makePart("2026-03-07", ["live-b", "shared", "live-c"]),
      },
    ];
    const { legacy, totalUsers } = expectSameAsLegacy(fixture);
    expect(legacy.userIds).toEqual(["edge-a", "shared", "live-b", "live-c"]);
    expect(totalUsers).toBe(4);
  });

  it("handles empty user lists, empty days and an empty window", () => {
    expectSameAsLegacy([]);
    expectSameAsLegacy([{ day: "2026-04-01", materialized: makePart("2026-04-01", []) }]);
    const fixture: DayFixture[] = [
      { day: "2026-04-02", materialized: makePart("2026-04-02", []) },
      { day: "2026-04-02", edge: makePart("2026-04-02", ["late"]) },
      { day: "2026-04-03", materialized: makePart("2026-04-03", []) },
      { day: "2026-04-04", edge: makePart("2026-04-04", []) },
    ];
    const { legacy, totalUsers } = expectSameAsLegacy(fixture);
    expect(legacy.userIds).toEqual(["late"]);
    expect(totalUsers).toBe(1);
  });

  it("matches the legacy merge over a 30-day window", () => {
    const fixture: DayFixture[] = [];
    for (let d = 0; d < 30; d++) {
      const day = `2026-05-${String(d + 1).padStart(2, "0")}`;
      const users = Array.from({ length: 2_000 }, (_, i) =>
        i < 500 ? `carry-${i}` : `d${d}-u${i}`,
      );
      fixture.push({ day, materialized: makePart(day, users) });
    }
    // Last day split into a materialized part plus a live edge part.
    const last = fixture[29];
    last.materialized = makePart(last.day, last.materialized!.userIds.slice(0, 1_200));
    last.edge = makePart(last.day, ["carry-7", ...last.materialized.userIds.slice(300)]);
    const { legacy, totalUsers } = expectSameAsLegacy(fixture);
    expect(legacy.userIds.length).toBe(totalUsers);
    expect(new Set(legacy.userIds).size).toBe(totalUsers);
  });

  it("matches the legacy merge on randomized fixtures", () => {
    const rng = makeRng(0x5eed);
    const pick = <T>(list: T[]) => list[Math.floor(rng() * list.length)];
    const pool = Array.from({ length: 24 }, (_, i) => `user-${i}`);
    for (let round = 0; round < 40; round++) {
      const dayCount = 1 + Math.floor(rng() * 6);
      const fixture: DayFixture[] = [];
      for (let d = 0; d < dayCount; d++) {
        const day = `2026-06-${String(d + 1).padStart(2, "0")}`;
        const users = () => {
          const chosen = new Set<string>();
          const size = Math.floor(rng() * 12);
          while (chosen.size < size) chosen.add(pick(pool));
          return [...chosen];
        };
        const entry: DayFixture = { day };
        if (rng() < 0.85) entry.materialized = makePart(day, users());
        if (rng() < 0.5) entry.edge = makePart(day, users());
        if (!entry.materialized && !entry.edge) entry.materialized = makePart(day, []);
        fixture.push(entry);
      }
      expectSameAsLegacy(fixture);
    }
  });

  it("keeps the plain DayStats overload behaving exactly as before", () => {
    // Existing callers pass a materialized DayStats as the accumulator; that
    // path must stay byte-for-byte identical (it is the array-scan variant).
    const fixture: DayFixture[] = [
      { day: "2026-07-01", materialized: makePart("2026-07-01", ["a", "b"]) },
      { day: "2026-07-01", edge: makePart("2026-07-01", ["b", "c"]) },
    ];
    const legacy = legacyAggregate(fixture);
    const target = structuredClone(fixture[0].materialized!);
    accumulateDayStats(target, fixture[1].edge!);
    expect(target).toEqual(legacy.days[0]);
  });

  it("does not alias the accumulator set or the source day", () => {
    const source = makePart("2026-08-01", ["x", "y"]);
    const acc = toDayStatsAccumulator(source);
    const snapshot = finalizeDayStats(acc);

    accumulateDayStats(acc, makePart("2026-08-01", ["z"]));
    expect(source.userIds).toEqual(["x", "y"]);
    expect(snapshot.userIds).toEqual(["x", "y"]);
    expect(acc.userIds.size).toBe(3);
    expect(acc.latHist).not.toBe(source.latHist);
    expect(snapshot.latHist).not.toBe(acc.latHist);
  });
});

// ---------------------------------------------------------------------------
// Scaling (the merge loop `buildDashboard` runs per request)
// ---------------------------------------------------------------------------

/** All-distinct users per day: the worst case for the legacy array scan. */
function perfFixture(days: number, usersPerDay: number): DayFixture[] {
  const fixture: DayFixture[] = [];
  for (let d = 0; d < days; d++) {
    const day = `2026-09-${String(d + 1).padStart(2, "0")}`;
    const users = Array.from({ length: usersPerDay }, (_, i) => `day${d}-user${i}`);
    fixture.push({
      day,
      materialized: makePart(day, users.slice(0, Math.ceil(usersPerDay / 2))),
      edge: makePart(day, users.slice(Math.ceil(usersPerDay / 2))),
    });
  }
  return fixture;
}

const FULL_SCALE = process.env.PERF_DEDUP_FULL === "1";
const SCALES = FULL_SCALE ? [5_000, 10_000] : [200, 1_000];

describe("merge-loop scaling (§7.1)", () => {
  for (const usersPerDay of SCALES) {
    it(`30 days x ${usersPerDay.toLocaleString()} users stays equivalent and sublinear`, {
      timeout: 300_000,
    }, () => {
      const fixture = perfFixture(30, usersPerDay);

      const legacyStart = performance.now();
      const legacy = legacyAggregate(fixture);
      const legacyMs = performance.now() - legacyStart;

      const nextStart = performance.now();
      const next = accumulatorAggregate(fixture);
      const nextMs = performance.now() - nextStart;

      // Equivalence first: the benchmark is only meaningful if it computes
      // the same thing.
      expect(next.days).toEqual(legacy.days);
      expect(next.window).toEqual(legacy.window);
      expect(next.totalUsers).toBe(30 * usersPerDay);

      console.log(
        `dedup merge 30d x ${usersPerDay} users: legacy ${legacyMs.toFixed(1)}ms -> ` +
          `accumulator ${nextMs.toFixed(2)}ms (${(legacyMs / Math.max(nextMs, 0.001)).toFixed(0)}x)`,
      );
      expect(nextMs).toBeLessThan(legacyMs / 5);
    });
  }
});
