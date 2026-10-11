/**
 * Bun driver for the `PERIFUSE_ENGINE=sqlite` session-scale benchmark — the
 * `sessions-scale-bench.test.ts` measurement plus the statement capture of
 * `sessions-scale-diagnostic.test.ts`.
 *
 * Why a separate driver? The sqlite engine requires the Bun runtime
 * (`PERIFUSE_SQLITE_REQUIRES_BUN`), while the server vitest suite runs on Node
 * (root AGENTS.md rule 6), and running that suite on Bun hits a vite-node zod
 * interop bug. This driver runs the same route capture, plan capture and
 * percentile logic on plain Bun, the documented product runtime.
 *
 * Run (from packages/server):
 *   PERIFUSE_ENGINE=sqlite PERIFUSE_BENCH_TRACES=1000000 \
 *     bun --bun src/__tests__/sessions-scale-bun-driver.ts
 *
 * Measured 2026-10-11 (same corpora as the vitest benchmark): the standard
 * SQLite planner keeps the `(project_id, trace_id)` primary-key plan at 1M
 * where the default Turso engine flips to `idx_trace_metrics_ts (project_id=?)`,
 * so both 1M scenarios answer 200 instead of 503. §12 is still missed at 1M —
 * the flip disappears, the aggregation cost does not. Results and the Turso
 * contrast live in the README performance section.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { TelemetryDBAdapter, TelemetryQueryOpts } from "@peri-fuse/shared/src/server/adapters";
import {
  TEST_AUTH_DB,
  TEST_DB_DIR,
  TEST_GATEWAY_DB,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  TEST_PUBLIC_KEY,
  TEST_SALT,
  TEST_SECRET_KEY,
  TEST_TELEMETRY_DB,
} from "./test-db-paths";

const SCALE = Number(process.env.PERIFUSE_BENCH_TRACES ?? "") || 0;
if (SCALE <= 0) throw new Error("PERIFUSE_BENCH_TRACES is required");
const WARMUP_ITERATIONS = 5;
const LATENCY_ITERATIONS = 55;
const STATEMENT_ITERATIONS = Number(process.env.PERIFUSE_BENCH_STATEMENT_SAMPLES ?? "") || 50;

// Same bootstrap as global-setup.ts, minus the final closeDb(): vitest runs
// globalSetup in a separate process from the workers, while this driver keeps
// one process, so the auth connection must stay open for route authentication.
process.env.LANGFUSE_MODE = "lite";
process.env.PERIFUSE_HOME = TEST_DB_DIR;
process.env.DATABASE_URL = `file:${TEST_AUTH_DB}`;
process.env.LANGFUSE_SQLITE_DB_PATH = TEST_TELEMETRY_DB;
process.env.GATEWAY_DB_URL = `file:${TEST_GATEWAY_DB}`;
process.env.SALT = TEST_SALT;
process.env.PERIFUSE_IO_COMPRESSION_WRITE = "off";

fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DB_DIR, { recursive: true });

const gateway = await import("@peri/gateway/db");
await gateway.ensureSchema();
await gateway.closeDb();

const sharedDb = await import("@peri-fuse/shared/src/db");
await sharedDb.ensureSchema();
const { organizations, projects, apiKeys } = await import(
  "@peri-fuse/shared/src/db/schema/index.js"
);
const { hashSecretKey, createShaHash } = await import("@peri-fuse/shared/src/server");
await sharedDb.prisma
  .insert(organizations)
  .values({ id: TEST_ORG_ID, name: "Lite Server Test Org" });
await sharedDb.prisma.insert(projects).values({
  id: TEST_PROJECT_ID,
  orgId: TEST_ORG_ID,
  name: "Lite Server Test",
});
await sharedDb.prisma.insert(apiKeys).values({
  id: randomUUID(),
  publicKey: TEST_PUBLIC_KEY,
  hashedSecretKey: await hashSecretKey(TEST_SECRET_KEY),
  fastHashedSecretKey: createShaHash(TEST_SECRET_KEY, TEST_SALT),
  displaySecretKey: `${TEST_SECRET_KEY.slice(0, 10)}...`,
  projectId: TEST_PROJECT_ID,
  organizationId: TEST_ORG_ID,
  scope: "PROJECT",
});

const { seedScaleCorpus } = await import("./sessions-scale-corpus");
const { getApp } = await import("./helpers");
const { getTelemetryDB } = await import("@peri-fuse/shared/src/server/adapters");
const { resolveLocalEngine } = await import("@peri-fuse/shared/src/db/local");

type Captured = { query: string; params: Record<string, unknown> };

async function captureRouteStatements(
  auth: string,
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
      headers: { Authorization: auth },
    });
    return { status: res.status, captured };
  } finally {
    db.query = original;
  }
}

function splitStatements(captured: Captured[], label: string): { list: Captured; count: Captured } {
  const isCount = (entry: Captured) => /COUNT\(DISTINCT session_id\)/.test(entry.query);
  const list = captured.find((entry) => !isCount(entry));
  const count = captured.find(isCount);
  if (!list) throw new Error(`${label}: no page statement captured`);
  if (!count) throw new Error(`${label}: no count statement captured`);
  return { list, count };
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

async function measureRequestLatency(
  auth: string,
  search: string,
): Promise<{ latency: Percentiles; statuses: number[]; rowCount: number }> {
  const samples: number[] = [];
  const statuses: number[] = [];
  let rowCount = 0;
  for (let index = 0; index < LATENCY_ITERATIONS; index++) {
    const started = performance.now();
    const res = await getApp().request(`/api/public/sessions${search}&__latency=${index}`, {
      headers: { Authorization: auth },
    });
    const elapsed = performance.now() - started;
    statuses.push(res.status);
    if (res.status === 200) rowCount = ((await res.json()) as { data: unknown[] }).data.length;
    else await res.text();
    if (index >= WARMUP_ITERATIONS) samples.push(elapsed);
  }
  return { latency: percentiles(samples), statuses, rowCount };
}

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

console.log(
  `[bun-scale] bun ${Bun.version} engine=${resolveLocalEngine()} readWorkers=${process.env.PERIFUSE_READ_WORKERS ?? "default"}`,
);
const corpus = await seedScaleCorpus(SCALE);
console.log(
  `[bun-scale] seeded ${corpus.traceCount} traces / ${corpus.metricCount} metrics / ${corpus.sessionCount} sessions (seed ${round(corpus.seedMs)}ms, ANALYZE ${round(corpus.analyzeMs)}ms)`,
);

for (const scenario of SCENARIOS) {
  const search = `${scenario.search}&__scale=${randomUUID()}`;
  const { status, captured } = await captureRouteStatements(corpus.auth, search);
  console.log(`[bun-scale] ${scenario.name}: capture status=${status}`);
  if (status !== 200) continue;
  const { list, count } = splitStatements(captured, scenario.name);

  const listPlan = await explain(list.query, list.params);
  const planReport = (plan: string[]) => plan.map((line) => `      ${line}`).join("\n");
  console.log(`[bun-scale] ${scenario.name}: list plan\n${planReport(listPlan)}`);
  console.log(
    `[bun-scale] ${scenario.name}: count plan\n${planReport(await explain(count.query, count.params))}`,
  );

  const request = await measureRequestLatency(corpus.auth, search);
  const listStatement = await sampleStatement(list, STATEMENT_ITERATIONS);
  const countStatement = await sampleStatement(count, STATEMENT_ITERATIONS);

  const metricsLines = listPlan.filter((line) => line.includes("trace_metrics")).join("\n");
  console.log(
    `[bun-scale] ${scenario.name}: cache-miss request latency (n=${
      LATENCY_ITERATIONS - WARMUP_ITERATIONS
    }) ${format(request.latency)} statuses=${[...new Set(request.statuses)].join(",")} rows=${request.rowCount}`,
  );
  console.log(
    `[bun-scale] ${scenario.name}: list statement latency (n=${STATEMENT_ITERATIONS}) ${format(listStatement)}`,
  );
  console.log(
    `[bun-scale] ${scenario.name}: count statement latency (n=${STATEMENT_ITERATIONS}) ${format(countStatement)}`,
  );
  console.log(
    `[bun-scale] ${scenario.name}: plan invariant indexed=${/SEARCH tm USING/.test(metricsLines)} scanned=${/\bSCAN tm\b/.test(metricsLines)}`,
  );
  console.log(
    `[bun-scale] ${scenario.name}: §12 p95≤100 ${request.latency.p95 <= 100 ? "PASS" : "FAIL"} (${round(
      request.latency.p95,
    )}ms) p99≤250 ${request.latency.p99 <= 250 ? "PASS" : "FAIL"} (${round(request.latency.p99)}ms)`,
  );
}

const statRows = await getTelemetryDB().query<{ tbl: string; idx: string; stat: string }>({
  query: "SELECT tbl, idx, stat FROM sqlite_stat1 WHERE tbl IN ('traces','trace_metrics')",
  params: {},
});
console.log(`[bun-scale] sqlite_stat1 rows: ${statRows.length}`);
console.log("[bun-scale] done");

// The read pool workers and the query-statistics interval keep the Bun event
// loop alive; vitest normally terminates workers for the committed harness, so
// this driver closes both explicitly and exits.
await getTelemetryDB()
  .close()
  .catch(() => undefined);
await sharedDb.closeDb().catch(() => undefined);
process.exit(0);
