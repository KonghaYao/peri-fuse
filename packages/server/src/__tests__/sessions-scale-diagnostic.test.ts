/**
 * Session list scale diagnostic — raw statement cost at 100K / 1M
 * (performance review §3.4 support tool).
 *
 * Run (1M, bypasses the read pool's 30 s statement budget):
 *
 *   cd packages/server && PERIFUSE_READ_WORKERS=0 PERIFUSE_BENCH_TRACES=1000000 \
 *     npx vitest run src/__tests__/sessions-scale-diagnostic.test.ts
 *
 * Why a second scale harness? `sessions-scale-bench.test.ts` is the acceptance
 * run: it measures the public route under production limits, so a statement
 * that exceeds the read pool's 30 s budget only surfaces as a 503. This
 * diagnostic intercepts the route's `db.query` calls, raises `timeoutMs`
 * (default 300 s, override with `PERIFUSE_BENCH_QUERY_TIMEOUT_MS`) and, with
 * `PERIFUSE_READ_WORKERS=0`, disables the read pool so the *same* statements can
 * finish and report their true cost: per-statement wall time and row count, the
 * full SQL, `EXPLAIN QUERY PLAN`, and the `sqlite_stat1` rows.
 *
 * Known result (2026-10-11, default Turso engine): at 1M traces the planner
 * flips the `trace_metrics` join from `sqlite_autoindex_trace_metrics_1
 * (project_id=? AND trace_id=?)` (the plan at 1K/100K) to
 * `idx_trace_metrics_ts (project_id=?)`, so every outer row scans the project's
 * whole metrics prefix (~900K entries). The default trace-ranked page statement
 * then needs ~214 s for 50 rows (30 ms at 100K), and the metric-ranked one does
 * not finish within the raised budget; system SQLite 3.51.0 plans the same SQL
 * on the same database file with the primary-key index and runs it in ~3.8 s, so
 * the flip costs ~56x here (the flip and the system-SQLite plan contrast both
 * reproduce across runs). Treat the 1M numbers as the current gap to close (see
 * the README performance section and review §3.3).
 */
import { randomUUID } from "node:crypto";
import type { TelemetryDBAdapter, TelemetryQueryOpts } from "@peri-fuse/shared/src/server/adapters";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { beforeAll, describe, expect, it } from "vitest";
import { getApp } from "./helpers";
import { type ScaleCorpus, seedScaleCorpus } from "./sessions-scale-corpus";

/** Trace count of the corpus; 0 (unset) skips the whole suite. */
const SCALE = Number(process.env.PERIFUSE_BENCH_TRACES ?? "") || 0;
const RAISED_TIMEOUT_MS = Number(process.env.PERIFUSE_BENCH_QUERY_TIMEOUT_MS ?? "") || 300_000;
const SEED_TIMEOUT_MS = 600_000 * Math.max(1, SCALE / 100_000);
const TEST_TIMEOUT_MS = 30 * 60_000;

type Captured = {
  query: string;
  params: Record<string, unknown>;
  ms: number;
  rows?: number;
  error?: string;
};

const SCENARIOS = [
  { name: "trace-ranked default order", search: "?limit=50" },
  { name: "metric-ranked order", search: "?limit=50&orderBy=totalCost.desc" },
];

describe.skipIf(SCALE <= 0)("GET /api/public/sessions scale diagnostic", () => {
  let corpus: ScaleCorpus;

  beforeAll(async () => {
    corpus = await seedScaleCorpus(SCALE);
    console.log(
      `[sessions-scale-diag] seeded ${corpus.traceCount} traces / ${corpus.metricCount} metrics / ${corpus.sessionCount} sessions (seed ${Math.round(corpus.seedMs)}ms, ANALYZE ${Math.round(corpus.analyzeMs)}ms)`,
    );
  }, SEED_TIMEOUT_MS);

  for (const scenario of SCENARIOS) {
    it(
      `records the route statements (${scenario.name})`,
      async () => {
        const db = getTelemetryDB();
        const captured: Captured[] = [];
        const original = db.query;
        db.query = (async (opts: TelemetryQueryOpts) => {
          const started = performance.now();
          try {
            const rows = await original.call(db, { ...opts, timeoutMs: RAISED_TIMEOUT_MS });
            captured.push({
              query: opts.query,
              params: opts.params ?? {},
              ms: performance.now() - started,
              rows: rows.length,
            });
            return rows;
          } catch (error) {
            captured.push({
              query: opts.query,
              params: opts.params ?? {},
              ms: performance.now() - started,
              error: String(error),
            });
            throw error;
          }
        }) as TelemetryDBAdapter["query"];
        let status = 0;
        let body = "";
        const requestStarted = performance.now();
        try {
          const res = await getApp().request(
            `/api/public/sessions${scenario.search}&__diag=${randomUUID()}`,
            { headers: { Authorization: corpus.auth } },
          );
          status = res.status;
          body = (await res.text()).slice(0, 120);
        } catch (error) {
          body = `threw ${String(error)}`;
        } finally {
          db.query = original;
        }
        console.log(
          `[sessions-scale-diag] ${scenario.name}: status=${status} requestMs=${Math.round(performance.now() - requestStarted)} body=${body}`,
        );
        for (const entry of captured) {
          console.log(
            `[sessions-scale-diag] ${scenario.name}: stmt ms=${Math.round(entry.ms)} rows=${entry.rows ?? "-"} error=${entry.error ?? "-"} sqlLen=${entry.query.length} params=${JSON.stringify(entry.params)}`,
          );
          try {
            const plan = await db.query<{ detail: unknown }>({
              query: `EXPLAIN QUERY PLAN ${entry.query}`,
              params: entry.params,
            });
            console.log(
              `[sessions-scale-diag] ${scenario.name}: plan\n${plan.map((row) => `      ${String(row.detail)}`).join("\n")}`,
            );
          } catch (error) {
            console.log(`[sessions-scale-diag] ${scenario.name}: plan error ${String(error)}`);
          }
          console.log(`[sessions-scale-diag] ${scenario.name}: FULL SQL\n${entry.query}`);
        }
        const statRows = await db.query<{ tbl: string; idx: string; stat: string }>({
          query: "SELECT tbl, idx, stat FROM sqlite_stat1 WHERE tbl IN ('traces','trace_metrics')",
          params: {},
        });
        for (const row of statRows)
          console.log(`[sessions-scale-diag] stat1 ${row.tbl} ${row.idx} ${row.stat}`);
        expect(captured.length, `${scenario.name}: route executed statements`).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
