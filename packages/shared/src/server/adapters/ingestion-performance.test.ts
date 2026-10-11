import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction } from "@tursodatabase/database";
import { expect, it, vi } from "vitest";
import type { LocalDatabase } from "../../db/local";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

const TRACES = 1000;
const timestamp = "2026-01-01 00:00:00.000";
const records = Array.from({ length: TRACES }, (_, index) => ({
  project_id: "p",
  id: `trace-${index}`,
  name: `trace-${index}`,
  timestamp,
  event_ts: timestamp,
  updated_at: timestamp,
  input: "hello",
  output: "world",
}));
const opts = {
  table: "traces",
  records,
  updateColumns: records.map(() => ["name", "timestamp", "input", "output"]),
  eventIds: records.map((_, index) => `event-${index}`),
};
/** The SQL load of one phase, measured at the transaction handle. */
const INSERT_PHASE = { get: 7000, run: 4001, all: 0 };
const RETRY_PHASE = { get: 2000, run: 0, all: 0 };

type DriverStatement = {
  run(...parameters: unknown[]): Promise<unknown>;
  get(...parameters: unknown[]): Promise<unknown>;
  all(...parameters: unknown[]): Promise<unknown[]>;
  close?: () => unknown;
};

type Counter = {
  /** Calls to `Transaction.prepare`: one per statement compile. */
  prepare: number;
  /** Statement executions (cached statements and driver-internal ones). */
  statement: { run: number; get: number; all: number };
  /** Calls that stayed on the uncached `tx.run/get/all` path. */
  tx: { run: number; get: number; all: number };
};

const emptyCounter = (): Counter => ({
  prepare: 0,
  statement: { run: 0, get: 0, all: 0 },
  tx: { run: 0, get: 0, all: 0 },
});

/**
 * Instruments the transaction handle the adapter works with.
 *
 * `blockPrepare` makes the statement cache disable itself (its documented
 * degradation path), which keeps every call on the original `tx.run/get/all`
 * path — that is the "cache off" baseline. Otherwise the probe counts the
 * statements the adapter prepares, so the cache-on run can be compared with it.
 */
function probeTransactions(db: LocalDatabase, counter: Counter, blockPrepare: boolean) {
  const transaction = db.transactionAsync.bind(db);
  return vi.spyOn(db, "transactionAsync").mockImplementation((callback) =>
    transaction(async (tx, ...args) => {
      const proxy = new Proxy(tx, {
        get(target, name) {
          if (name === "prepare") {
            if (blockPrepare)
              return () => {
                throw new Error("STATEMENT_CACHE_DISABLED");
              };
            const prepare = Reflect.get(target, name) as (sql: string) => Promise<DriverStatement>;
            return (sql: string) => {
              counter.prepare += 1;
              return Promise.resolve(prepare.call(target, sql)).then((statement) => ({
                run: (...parameters: unknown[]) => {
                  counter.statement.run += 1;
                  return statement.run(...parameters);
                },
                get: (...parameters: unknown[]) => {
                  counter.statement.get += 1;
                  return statement.get(...parameters);
                },
                all: (...parameters: unknown[]) => {
                  counter.statement.all += 1;
                  return statement.all(...parameters);
                },
                close: () => statement.close?.(),
              }));
            };
          }
          const value = Reflect.get(target, name);
          if (name === "get" || name === "run" || name === "all")
            return (...parameters: unknown[]) => {
              counter.tx[name as "get" | "run" | "all"] += 1;
              return value.apply(target, parameters);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return callback(proxy, ...args);
    }),
  );
}

/**
 * Runs the same insert/retry load with fresh databases.
 *
 * `bare` leaves the adapter alone (production shape), `reuse` instruments the
 * cache-on path and `no-reuse` blocks `prepare` so the cache disables itself
 * and every call stays on the original `tx.run/get/all` path. `spyDriver`
 * additionally counts `Transaction.prepare` itself — the number of statements
 * the engine really compiles; it is off for timing runs because a mock on the
 * hot path would slow the uncached leg down.
 */
async function measure(
  mode: "bare" | "reuse" | "no-reuse",
  repetitions: number,
  spyDriver = false,
) {
  const samples: Record<string, number[]> = { insert: [], retry: [] };
  const measured: Record<string, Counter & { driverPrepare: number }> = {};
  const prepareSpy = spyDriver ? vi.spyOn(Transaction.prototype, "prepare") : null;
  try {
    for (let round = 0; round < repetitions; round++) {
      const root = mkdtempSync(join(tmpdir(), "peri-ingestion-test-performance-"));
      const adapter = new SQLiteTelemetryAdapter(join(root, "telemetry.db"));
      await adapter.initialize();
      const counter = emptyCounter();
      const spy =
        mode === "bare"
          ? null
          : probeTransactions(adapter.getDatabase(), counter, mode === "no-reuse");
      try {
        for (const phase of ["insert", "retry"]) {
          counter.prepare = 0;
          counter.statement = { run: 0, get: 0, all: 0 };
          counter.tx = { run: 0, get: 0, all: 0 };
          prepareSpy?.mockClear();
          const start = performance.now();
          await adapter.insert(opts);
          samples[phase].push(performance.now() - start);
          measured[phase] = {
            ...structuredClone(counter),
            driverPrepare: prepareSpy?.mock.calls.length ?? 0,
          };
        }
        expect(await adapter.getDatabase().get("SELECT count(*) AS n FROM traces")).toEqual({
          n: TRACES,
        });
      } finally {
        spy?.mockRestore();
        await adapter.close();
      }
    }
  } finally {
    prepareSpy?.mockRestore();
  }
  return { samples, measured };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

it("measures 1,000 trace inserts and exact retries at the transaction driver boundary", async () => {
  const cached = await measure("reuse", 1, true);
  const uncached = await measure("no-reuse", 1, true);

  // The uncached path runs every logical operation as its own statement, so the
  // driver compiles exactly one statement per `tx.run/get/all` call. Both
  // counts are measured independently: the probe sees the adapter's calls, the
  // driver spy sees the compiles.
  expect(uncached.measured.insert.tx).toEqual(INSERT_PHASE);
  expect(uncached.measured.retry.tx).toEqual(RETRY_PHASE);
  expect(uncached.measured.insert.prepare).toBe(0);
  expect(uncached.measured.insert.statement).toEqual({ run: 0, get: 0, all: 0 });
  expect(uncached.measured.insert.driverPrepare).toBe(INSERT_PHASE.get + INSERT_PHASE.run);
  expect(uncached.measured.retry.driverPrepare).toBe(RETRY_PHASE.get);

  // The cached path executes the same statements, but compiles each SQL text once.
  expect(cached.measured.insert.statement).toEqual(INSERT_PHASE);
  expect(cached.measured.insert.tx).toEqual({ run: 0, get: 0, all: 0 });
  expect(cached.measured.retry.statement).toEqual(RETRY_PHASE);
  expect(cached.measured.retry.tx).toEqual({ run: 0, get: 0, all: 0 });
  expect(cached.measured.insert.driverPrepare).toBe(cached.measured.insert.prepare);
  expect(cached.measured.retry.driverPrepare).toBe(cached.measured.retry.prepare);
  expect(cached.measured.insert.prepare).toBeLessThan(INSERT_PHASE.get + INSERT_PHASE.run);
  expect(cached.measured.retry.prepare).toBeGreaterThan(0);

  console.info(
    JSON.stringify({
      phase: "insert",
      cacheOff: uncached.measured.insert,
      cacheOn: cached.measured.insert,
      cacheOffMs: Number(uncached.samples.insert[0].toFixed(2)),
      cacheOnMs: Number(cached.samples.insert[0].toFixed(2)),
    }),
  );
  console.info(
    JSON.stringify({
      phase: "retry",
      cacheOff: uncached.measured.retry,
      cacheOn: cached.measured.retry,
      cacheOffMs: Number(uncached.samples.retry[0].toFixed(2)),
      cacheOnMs: Number(cached.samples.retry[0].toFixed(2)),
    }),
  );
}, 30_000);

it("compares the ingestion load with and without statement reuse", async () => {
  const repetitions = 5;
  // The cached leg runs the production shape; the uncached leg needs the
  // blocking probe to reach the pre-cache path, which adds one proxy hop per
  // statement call and therefore favours the cached leg slightly.
  const cached = await measure("bare", repetitions);
  const uncached = await measure("no-reuse", repetitions);
  const report = (values: number[]) => ({
    medianMs: Number(median(values).toFixed(2)),
    samplesMs: values.map((value) => Number(value.toFixed(2))),
  });
  const on = report(cached.samples.insert);
  const off = report(uncached.samples.insert);
  console.info(JSON.stringify({ measurement: "cache-on", insert: on }));
  console.info(JSON.stringify({ measurement: "cache-off", insert: off }));
  // Deliberately no assertion beyond the row count checked inside `measure`:
  // the cache removes SQL compilation only, so a difference below the
  // run-to-run spread is "no measurable gain" rather than a regression. This
  // run only logs wall time; the deterministic statement counts live in the
  // driver-boundary test above.
}, 120_000);
