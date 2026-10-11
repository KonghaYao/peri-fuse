/**
 * Session list query plan, latency benchmark, and old/new equivalence harness.
 *
 * Backs the performance review §3 ("修复 Session 查询计划与分页工作量"): the
 * suite seeds a 1,000-trace corpus (see `sessions-bench-corpus.ts`) into a
 * dedicated project and then
 *
 *   1. captures the SQL the route actually executes (adapter interception),
 *   2. records `EXPLAIN QUERY PLAN` for the captured SQL and for a frozen copy
 *      of the pre-P1 baseline SQL,
 *   3. measures cache-MISS response and statement latency for a 50-row page on
 *      both query shapes (trace-ranked and metric-ranked ordering),
 *   4. compares the frozen baseline query against the current route query for a
 *      matrix of filter/sort combinations, row by row.
 *
 * The frozen baseline lives in `sessions-bench-baseline.ts`: it is the pre-P1
 * statement kept as a reference implementation and is never executed by the
 * route.
 */
import { randomUUID } from "node:crypto";
import type { TelemetryDBAdapter, TelemetryQueryOpts } from "@peri-fuse/shared/src/server/adapters";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { beforeAll, describe, expect, it } from "vitest";
import { getApp } from "./helpers";
import {
  legacySessionCountSql,
  legacySessionListSql,
  ORDER_EXPRESSIONS,
} from "./sessions-bench-baseline";
import {
  SESSION_COUNT,
  type SessionCorpus,
  seedSessionCorpus,
  TAG_POOL,
  TRACE_COUNT,
} from "./sessions-bench-corpus";

const LATENCY_ITERATIONS = 55;
/** Iterations of the frozen baseline statement (each one costs ~70x the new one). */
const BASELINE_ITERATIONS = 10;

// ---------------------------------------------------------------------------
// Route SQL capture (interception) + plan/latency helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Captured = { query: string; params: Record<string, unknown> };

/**
 * Runs one request and records every statement the route executes. The adapter
 * method is restored afterwards, so interception stays local to this call.
 */
async function captureRouteStatements(
  corpus: SessionCorpus,
  search: string,
): Promise<{ status: number; captured: Captured[] }> {
  const db = getTelemetryDB();
  const captured: Captured[] = [];
  const original = db.query;
  db.query = (async (opts: TelemetryQueryOpts) => {
    captured.push({ query: opts.query, params: opts.params ?? {} });
    return original.call(db, opts);
  }) as TelemetryDBAdapter["query"];
  try {
    const res = await getApp().request(`/api/public/sessions${search}`, {
      headers: { Authorization: corpus.auth },
    });
    return { status: res.status, captured };
  } finally {
    db.query = original;
  }
}

/** Splits the captured statements into the page query and the total count. */
function splitStatements(captured: Captured[], label: string): { list: Captured; count: Captured } {
  const isCount = (entry: Captured) => /COUNT\(DISTINCT session_id\)/.test(entry.query);
  const list = captured.find((entry) => !isCount(entry));
  const count = captured.find(isCount);
  expect(list, `${label}: page statement`).toBeDefined();
  expect(count, `${label}: count statement`).toBeDefined();
  return { list: list as Captured, count: count as Captured };
}

async function explain(sql: string, params: Record<string, unknown>): Promise<string[]> {
  const rows = await getTelemetryDB().query<{ detail?: unknown }>({
    query: `EXPLAIN QUERY PLAN ${sql}`,
    params,
  });
  return rows.map((row) => String(row.detail ?? ""));
}

/** numeric fields are compared with a relative epsilon (SUM order may vary). */
function expectEquivalentRows(actual: Row[], expected: Row[], label: string): void {
  expect(actual.length, `${label}: row count`).toBe(expected.length);
  expect(
    actual.map((row) => row.id),
    `${label}: order`,
  ).toEqual(expected.map((row) => row.id));
  const actualById = new Map(actual.map((row) => [String(row.id), row]));
  for (const expectedRow of expected) {
    const id = String(expectedRow.id);
    const actualRow = actualById.get(id) as Row;
    expect(Object.keys(actualRow).sort(), `${label}: ${id} columns`).toEqual(
      Object.keys(expectedRow).sort(),
    );
    for (const [key, left] of Object.entries(actualRow)) {
      const right = expectedRow[key];
      if (typeof left === "number" && typeof right === "number") {
        const tolerance = 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
        expect(Math.abs(left - right) <= tolerance, `${label}: ${id}.${key}`).toBe(true);
      } else {
        expect(left, `${label}: ${id}.${key}`).toEqual(right);
      }
    }
  }
}

type Percentiles = { p50: number; p95: number; p99: number; min: number; max: number };

function percentiles(samples: number[]): Percentiles {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (ratio: number) => sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const round = (value: number) => Number(value.toFixed(2));

const format = (percentile: Percentiles) =>
  `p50=${round(percentile.p50)}ms p95=${round(percentile.p95)}ms p99=${round(
    percentile.p99,
  )}ms max=${round(percentile.max)}ms`;

/** Cache-MISS request latency plus statement-level (SQL only) latency. */
async function measureLatency(
  corpus: SessionCorpus,
  search: string,
  list: Captured,
  count: Captured,
  baselineSql: string,
): Promise<{
  request: Percentiles;
  pageStatement: Percentiles;
  baselineStatement: Percentiles;
  rowCount: number;
}> {
  const db = getTelemetryDB();
  const samples: number[] = [];
  let rowCount = 0;
  for (let index = 0; index < LATENCY_ITERATIONS; index++) {
    const started = performance.now();
    const res = await getApp().request(`/api/public/sessions${search}&__latency=${index}`, {
      headers: { Authorization: corpus.auth },
    });
    const elapsed = performance.now() - started;
    expect(res.headers.get("X-Cache"), "expected a cache MISS").toBe("MISS");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    rowCount = body.data.length;
    if (index >= 5) samples.push(elapsed);
  }
  const statementSamples: number[] = [];
  const baselineSamples: number[] = [];
  for (let index = 0; index < LATENCY_ITERATIONS - 5; index++) {
    const started = performance.now();
    await db.query({ query: list.query, params: list.params });
    statementSamples.push(performance.now() - started);
    await db.query({ query: count.query, params: count.params });
    if (index < BASELINE_ITERATIONS) {
      const baselineStarted = performance.now();
      await db.query({ query: baselineSql, params: list.params });
      baselineSamples.push(performance.now() - baselineStarted);
    }
  }
  return {
    request: percentiles(samples),
    pageStatement: percentiles(statementSamples),
    baselineStatement: percentiles(baselineSamples),
    rowCount,
  };
}

// ---------------------------------------------------------------------------
// Filter/sort matrix
// ---------------------------------------------------------------------------

const session000 = "bench-session-000";
const session199 = "bench-session-199";
const fromIso = "2026-01-10T00:00:00.000Z";
const toIso = "2026-01-20T00:00:00.000Z";

const MATRIX: { name: string; search: string }[] = [
  { name: "default page 1", search: "?limit=50" },
  { name: "default page 2", search: "?limit=50&page=2" },
  { name: "page beyond end", search: "?limit=50&page=99" },
  { name: "limit 1", search: "?limit=1" },
  { name: "session id", search: `?sessionId=${session000}` },
  { name: "session id miss", search: "?sessionId=bench-session-absent" },
  { name: "user id substring", search: "?userId=bench-user-3" },
  { name: "user id comma", search: `?userId=${encodeURIComponent("bench,user")}` },
  { name: "tag exact", search: `?tags=${encodeURIComponent(TAG_POOL[0])}` },
  { name: "tag absent", search: "?tags=bench-tag-absent" },
  { name: "environment substring", search: "?environment=prod" },
  { name: "from timestamp", search: `?fromTimestamp=${fromIso}` },
  { name: "to timestamp", search: `?toTimestamp=${toIso}` },
  {
    name: "time window + user + tag + environment",
    search: `?fromTimestamp=${fromIso}&toTimestamp=${toIso}&userId=bench-user&tags=${encodeURIComponent(
      TAG_POOL[0],
    )}&environment=default&limit=25&page=2`,
  },
  { name: "session + environment", search: `?sessionId=${session199}&environment=prod` },
  { name: "max limit", search: "?limit=500" },
  { name: "unknown orderBy falls back", search: "?orderBy=bogus.asc" },
  ...Object.keys(ORDER_EXPRESSIONS).flatMap((column) => [
    { name: `order ${column} asc`, search: `?orderBy=${column}.asc&limit=20` },
    { name: `order ${column} desc`, search: `?orderBy=${column}.desc&limit=20` },
  ]),
];

const SCENARIOS = [
  { name: "trace-ranked default order", search: "?limit=50" },
  { name: "metric-ranked order", search: "?limit=50&orderBy=totalCost.desc" },
];

describe("GET /api/public/sessions query plan + latency", () => {
  let corpus: SessionCorpus;

  beforeAll(async () => {
    corpus = await seedSessionCorpus();
  }, 300_000);

  it("returns identical pages for the frozen baseline query and the current route", async () => {
    const db = getTelemetryDB();
    for (const [index, entry] of MATRIX.entries()) {
      const search = `${entry.search}&__matrix=${index}`;
      const { status, captured } = await captureRouteStatements(corpus, search);
      expect(status, entry.name).toBe(200);
      const { list, count } = splitStatements(captured, entry.name);
      const query = new URLSearchParams(search);

      const currentRows = await db.query<Row>({ query: list.query, params: list.params });
      const baselineRows = await db.query<Row>({
        query: legacySessionListSql(query),
        params: list.params,
      });
      expectEquivalentRows(currentRows, baselineRows, entry.name);

      const currentCount = await db.query<Row>({ query: count.query, params: count.params });
      const baselineCount = await db.query<Row>({
        query: legacySessionCountSql(query),
        params: count.params,
      });
      expect(currentCount, `${entry.name}: count`).toEqual(baselineCount);
    }
  }, 180_000);

  for (const scenario of SCENARIOS) {
    it(`keeps the metrics lookup indexed and serves 50 rows within budget (${scenario.name})`, async () => {
      const db = getTelemetryDB();
      // A unique marker keeps every request a cache miss.
      const search = `${scenario.search}&__bench=${randomUUID()}`;
      const { captured } = await captureRouteStatements(corpus, search);
      const { list, count } = splitStatements(captured, scenario.name);
      const query = new URLSearchParams(search);

      const baselinePlan = await explain(legacySessionListSql(query), list.params);
      const currentPlan = await explain(list.query, list.params);
      const metricsLines = currentPlan.filter((line) => line.includes("trace_metrics"));
      const statRows = await db.query<{ count: number }>({
        query: "SELECT COUNT(*) AS count FROM sqlite_stat1",
        params: {},
      });
      const measured = await measureLatency(
        corpus,
        search,
        list,
        count,
        legacySessionListSql(query),
      );
      const planReport = (plan: string[]) => plan.map((line) => `      ${line}`).join("\n");
      console.log(
        [
          `[sessions-query-plan] ${scenario.name}: corpus ${TRACE_COUNT} traces / ${SESSION_COUNT} sessions, ${measured.rowCount} rows`,
          `[sessions-query-plan] ${scenario.name}: sqlite_stat1 rows ${statRows[0]?.count ?? 0}`,
          `[sessions-query-plan] ${scenario.name}: baseline plan\n${planReport(baselinePlan)}`,
          `[sessions-query-plan] ${scenario.name}: current plan\n${planReport(currentPlan)}`,
          `[sessions-query-plan] ${scenario.name}: cache-miss request latency (n=${
            LATENCY_ITERATIONS - 5
          }) ${format(measured.request)}`,
          `[sessions-query-plan] ${scenario.name}: page statement latency ${format(
            measured.pageStatement,
          )}`,
          `[sessions-query-plan] ${scenario.name}: frozen baseline statement latency (n=${
            BASELINE_ITERATIONS
          }) ${format(measured.baselineStatement)}`,
        ].join("\n"),
      );

      // The metrics aggregate must reach trace_metrics through an index lookup
      // (project_id, trace_id is the primary key) instead of a full scan, and
      // the statement must stay far away from the O(sessions x traces) shape.
      expect(metricsLines.join("\n")).toMatch(/SEARCH tm USING/);
      expect(metricsLines.join("\n")).not.toMatch(/\bSCAN tm\b/);
      expect(measured.pageStatement.p50).toBeLessThan(50);
      expect(measured.request.p95).toBeLessThan(250);
      expect(measured.pageStatement.p50 * 5).toBeLessThan(measured.baselineStatement.p50);
    }, 300_000);
  }
});
