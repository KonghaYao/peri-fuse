/**
 * Session list scale benchmark — 100k / 1M traces
 * (performance review §3.4: "检查 1 千、10 万、100 万 trace 下的计划与延迟").
 *
 * Run (100k):
 *
 *   cd packages/server && PERIFUSE_BENCH_TRACES=100000 npx vitest run \
 *     src/__tests__/sessions-scale-bench.test.ts
 *
 * The suite is gated on `PERIFUSE_BENCH_TRACES`, so the default
 * `pnpm run test` run neither seeds nor measures anything. The corpus itself is
 * loaded by `sessions-scale-corpus.ts` (raw chunked inserts, no ingestion).
 *
 * What it reports per scenario (`?limit=50` and `?limit=50&orderBy=totalCost.desc`):
 * corpus/seed/ANALYZE timing, `sqlite_stat1` row count, the full list and count
 * `EXPLAIN QUERY PLAN`, cache-MISS request percentiles (n=50 after 5 warmups)
 * and statement-level percentiles for the list and count statements.
 *
 * The frozen pre-P1 baseline statement is deliberately NOT measured here: its
 * shape is O(sessions x traces) (documented in `sessions-bench-baseline.ts` and
 * measured at ~30x on 1k traces), so running it over 100k/1M traces would risk
 * multi-minute statements and tell us nothing that the 1k baseline comparison
 * does not already cover.
 *
 * Known 1M behavior (2026-10-11, default Turso engine): at 1M traces the planner
 * flips the `trace_metrics` join from the `(project_id, trace_id)` primary-key
 * index to `idx_trace_metrics_ts (project_id=?)`, so every outer row scans the
 * project's whole metrics prefix. Both scenarios then exceed the read pool's
 * 30s statement budget and the route answers 503; the raw statement cost
 * (~214s for the default page) is reproducible with
 * `sessions-scale-diagnostic.test.ts`. A red 1M run is the finding, not a
 * harness bug.
 *
 * The SQL-capture / plan / percentile helpers below are a minimal copy of the
 * 1k benchmark (`sessions-query-plan.test.ts`) instead of an extraction: the
 * scale variant measures no baseline statement (different signature) and the
 * 1k suite's assertions and helpers must stay untouched.
 */
import { randomUUID } from "node:crypto";
import type { TelemetryDBAdapter, TelemetryQueryOpts } from "@peri-fuse/shared/src/server/adapters";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { beforeAll, describe, expect, it } from "vitest";
import { getApp } from "./helpers";
import { type ScaleCorpus, seedScaleCorpus } from "./sessions-scale-corpus";

/** Trace count of the corpus; 0 (unset) skips the whole suite. */
const SCALE = Number(process.env.PERIFUSE_BENCH_TRACES ?? "") || 0;
const WARMUP_ITERATIONS = 5;
/** Cache-MISS requests: 5 warmups + 50 measured samples. */
const LATENCY_ITERATIONS = 55;
/** Statement-level samples per captured statement. */
const STATEMENT_ITERATIONS = 50;
/** §12 acceptance targets for a 50-row page on the 8-core/16 GiB reference box. */
const REQUEST_P95_BUDGET_MS = 100;
const REQUEST_P99_BUDGET_MS = 250;
// Timeouts grow linearly with the corpus so the same file can also be pointed
// at 1M traces (`PERIFUSE_BENCH_TRACES=1000000`); 100k keeps the documented
// 600s seeding / 300s measurement budget.
const TIMEOUT_SCALE = Math.max(1, SCALE / 100_000);
const SEED_TIMEOUT_MS = 600_000 * TIMEOUT_SCALE;
const TEST_TIMEOUT_MS = 300_000 * TIMEOUT_SCALE;

type Captured = { query: string; params: Record<string, unknown> };
type BenchCorpus = { projectId: string; auth: string };

/**
 * Runs one request and records every statement the route executes. The adapter
 * method is restored afterwards, so interception stays local to this call.
 */
async function captureRouteStatements(
  corpus: BenchCorpus,
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

type RequestMeasurement = {
  latency: Percentiles;
  rowCount: number;
  totalItems: number;
};

/** Cache-MISS request latency (a unique marker keeps every request a miss). */
async function measureRequestLatency(
  corpus: BenchCorpus,
  search: string,
): Promise<RequestMeasurement> {
  const samples: number[] = [];
  let rowCount = 0;
  let totalItems = 0;
  for (let index = 0; index < LATENCY_ITERATIONS; index++) {
    const started = performance.now();
    const res = await getApp().request(`/api/public/sessions${search}&__latency=${index}`, {
      headers: { Authorization: corpus.auth },
    });
    const elapsed = performance.now() - started;
    expect(res.headers.get("X-Cache"), "expected a cache MISS").toBe("MISS");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta?: { totalItems?: number } };
    rowCount = body.data.length;
    totalItems = body.meta?.totalItems ?? 0;
    if (index >= WARMUP_ITERATIONS) samples.push(elapsed);
  }
  return { latency: percentiles(samples), rowCount, totalItems };
}

/** Statement-level (SQL only) latency of one captured statement. */
async function sampleStatement(statement: Captured, iterations: number): Promise<Percentiles> {
  const db = getTelemetryDB();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await db.query({ query: statement.query, params: statement.params });
    samples.push(performance.now() - started);
  }
  return percentiles(samples);
}

const SCENARIOS = [
  { name: "trace-ranked default order", search: "?limit=50" },
  { name: "metric-ranked order", search: "?limit=50&orderBy=totalCost.desc" },
];

describe.skipIf(SCALE <= 0)("GET /api/public/sessions scale benchmark", () => {
  let corpus: ScaleCorpus;

  beforeAll(async () => {
    corpus = await seedScaleCorpus(SCALE);
  }, SEED_TIMEOUT_MS);

  for (const scenario of SCENARIOS) {
    it(
      `serves a 50-row page with an indexed metrics lookup (${scenario.name})`,
      async () => {
        const db = getTelemetryDB();
        const search = `${scenario.search}&__scale=${randomUUID()}`;
        const { status, captured } = await captureRouteStatements(corpus, search);
        expect(status, scenario.name).toBe(200);
        const { list, count } = splitStatements(captured, scenario.name);

        const listPlan = await explain(list.query, list.params);
        const countPlan = await explain(count.query, count.params);
        const statRows = await db.query<{ count: number }>({
          query: "SELECT COUNT(*) AS count FROM sqlite_stat1",
          params: {},
        });
        const request = await measureRequestLatency(corpus, search);
        const listStatement = await sampleStatement(list, STATEMENT_ITERATIONS);
        const countStatement = await sampleStatement(count, STATEMENT_ITERATIONS);

        const planReport = (plan: string[]) => plan.map((line) => `      ${line}`).join("\n");
        console.log(
          [
            `[sessions-scale] ${scenario.name}: corpus ${corpus.traceCount} traces / ${corpus.metricCount} metric rows / ${corpus.sessionCount} sessions, seed ${round(corpus.seedMs)}ms, ANALYZE ${round(corpus.analyzeMs)}ms`,
            `[sessions-scale] ${scenario.name}: sqlite_stat1 rows ${statRows[0]?.count ?? 0}`,
            `[sessions-scale] ${scenario.name}: list plan\n${planReport(listPlan)}`,
            `[sessions-scale] ${scenario.name}: count plan\n${planReport(countPlan)}`,
            `[sessions-scale] ${scenario.name}: cache-miss request latency (n=${
              LATENCY_ITERATIONS - WARMUP_ITERATIONS
            }) ${format(request.latency)}`,
            `[sessions-scale] ${scenario.name}: list statement latency ${format(listStatement)}`,
            `[sessions-scale] ${scenario.name}: count statement latency ${format(countStatement)}`,
            `[sessions-scale] ${scenario.name}: page rows ${request.rowCount} of ${request.totalItems} total items`,
          ].join("\n"),
        );

        // Plan invariant (same as the 1k suite): the metrics aggregate must reach
        // trace_metrics through the (project_id, trace_id) primary key instead of
        // scanning the table.
        const metricsLines = listPlan.filter((line) => line.includes("trace_metrics"));
        expect(metricsLines.join("\n"), `${scenario.name}: indexed metrics lookup`).toMatch(
          /SEARCH tm USING/,
        );
        expect(metricsLines.join("\n"), `${scenario.name}: no metrics table scan`).not.toMatch(
          /\bSCAN tm\b/,
        );
        // §12 acceptance targets — never relax these to make a run pass; an
        // over-budget run is the finding (report the raw numbers).
        expect(
          request.latency.p95,
          `${scenario.name}: §12 p95 ≤ ${REQUEST_P95_BUDGET_MS}ms`,
        ).toBeLessThanOrEqual(REQUEST_P95_BUDGET_MS);
        expect(
          request.latency.p99,
          `${scenario.name}: §12 p99 ≤ ${REQUEST_P99_BUDGET_MS}ms`,
        ).toBeLessThanOrEqual(REQUEST_P99_BUDGET_MS);
        // A 100k corpus has 20k sessions, so the page is always full; smaller
        // smoke-test corpora return every session they have.
        const expectedRows = Math.min(50, corpus.sessionCount);
        expect(request.rowCount, `${scenario.name}: full page`).toBe(expectedRows);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
