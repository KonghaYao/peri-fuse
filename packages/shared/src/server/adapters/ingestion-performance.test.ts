import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

it("measures 1,000 trace inserts and exact retries at the transaction driver boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "peri-ingestion-test-performance-"));
  const adapter = new SQLiteTelemetryAdapter(join(root, "telemetry.db"));
  await adapter.initialize();
  const db = adapter.getDatabase();
  const transaction = db.transactionAsync.bind(db);
  const counts = { get: 0, run: 0, all: 0 };
  const spy = vi.spyOn(db, "transactionAsync").mockImplementation((callback) =>
    transaction(async (tx, ...args) => {
      const proxy = new Proxy(tx, {
        get(target, name) {
          const value = Reflect.get(target, name);
          if (name === "get" || name === "run" || name === "all")
            return (...parameters: unknown[]) => {
              counts[name]++;
              return value.apply(target, parameters);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return callback(proxy, ...args);
    }),
  );
  const records = Array.from({ length: 1000 }, (_, index) => ({
    project_id: "p",
    id: `trace-${index}`,
    name: `trace-${index}`,
    timestamp: "2026-01-01 00:00:00.000",
    event_ts: "2026-01-01 00:00:00.000",
    updated_at: "2026-01-01 00:00:00.000",
    input: "hello",
    output: "world",
  }));
  const opts = {
    table: "traces",
    records,
    updateColumns: records.map(() => ["name", "timestamp", "input", "output"]),
    eventIds: records.map((_, index) => `event-${index}`),
  };
  try {
    for (const phase of ["insert", "retry"]) {
      counts.get = counts.run = counts.all = 0;
      const start = performance.now();
      await adapter.insert(opts);
      const elapsedMs = performance.now() - start;
      console.info(
        JSON.stringify({ phase, ...counts, sql: counts.get + counts.run + counts.all, elapsedMs }),
      );
      expect(counts).toEqual(
        phase === "insert" ? { get: 7000, run: 4001, all: 0 } : { get: 2000, run: 0, all: 0 },
      );
    }
    expect(await db.get("SELECT count(*) AS n FROM traces")).toEqual({ n: 1000 });
  } finally {
    spy.mockRestore();
    await adapter.close();
  }
}, 30_000);
