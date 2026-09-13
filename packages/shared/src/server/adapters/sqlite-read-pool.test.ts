import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteReadPool } from "./sqlite-read-pool";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";
import { withTelemetryQuerySignal } from "./telemetry-query-context";

let directory: string;
let dbPath: string;
const pools: SqliteReadPool[] = [];
const adapters: SQLiteTelemetryAdapter[] = [];
const slots = (pool: SqliteReadPool) =>
  (pool as unknown as { slots: Array<{ worker: Worker }> }).slots;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "perifuse-read-pool-"));
  dbPath = join(directory, "test.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE items (value TEXT); INSERT INTO items VALUES ('hello'), ('world')");
  db.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all([
    ...pools.splice(0).map((pool) => pool.close()),
    ...adapters.splice(0).map((db) => db.close()),
  ]);
  rmSync(directory, { recursive: true, force: true });
});
function pool(options: ConstructorParameters<typeof SqliteReadPool>[2] = {}) {
  const instance = new SqliteReadPool(dbPath, 1, { restartDelayMs: 10, ...options });
  pools.push(instance);
  return instance;
}

const slowSql =
  "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT SUM(x) FROM n";

describe("SQLite read worker lifecycle", () => {
  it("replaces an exited worker and routes subsequent reads to its replacement", async () => {
    const reads = pool();
    await expect(reads.query("SELECT 1 AS n", {})).resolves.toEqual([{ n: 1 }]);
    await slots(reads)[0].worker.terminate();
    await expect(reads.query("SELECT 2 AS n", {})).resolves.toEqual([{ n: 2 }]);
    expect(reads.stats()).toMatchObject({ pending: 0, pendingBytes: 0, active: 0 });
  });

  it("rejects failed work on error and recovers without keeping dead requests", async () => {
    const reads = pool();
    await reads.query("SELECT 1", {});
    const request = reads.query(slowSql, {});
    const rejection = expect(request).rejects.toThrow("injected worker failure");
    slots(reads)[0].worker.emit("error", new Error("injected worker failure"));
    await rejection;
    await expect(reads.query("SELECT 3 AS n", {})).resolves.toEqual([{ n: 3 }]);
    expect(reads.stats().pending).toBe(0);
  });

  it("bounds actual active plus queued work and cancels a queued request", async () => {
    const reads = pool({ maxPending: 2 });
    await reads.query("SELECT 1", {});
    const active = reads.query(slowSql, {});
    const controller = new AbortController();
    const queued = reads.query("SELECT 2", {}, { signal: controller.signal });
    const rejection = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(reads.query("SELECT 3", {})).rejects.toMatchObject({ code: "OVERLOADED" });
    expect(reads.stats()).toMatchObject({ pending: 2, active: 1, queued: 1 });
    controller.abort();
    await rejection;
    expect(reads.stats()).toMatchObject({ pending: 1, active: 1 });
    await active;
    await expect(reads.query("SELECT 4 AS n", {})).resolves.toEqual([{ n: 4 }]);
  });

  it("times out queued requests and retires timed-out active workers", async () => {
    const reads = pool();
    await reads.query("SELECT 1", {});
    const active = reads.query(slowSql, {}, { timeoutMs: 40 });
    const activeRejection = expect(active).rejects.toMatchObject({ code: "TIMEOUT" });
    const queued = reads.query("SELECT 2", {}, { timeoutMs: 5 });
    await expect(queued).rejects.toMatchObject({ code: "TIMEOUT" });
    await activeRejection;
    expect(reads.stats().pending).toBe(0);
    await expect(reads.query("SELECT 4 AS n", {})).resolves.toEqual([{ n: 4 }]);
  });

  it("cancels active work and cleans up postMessage failures", async () => {
    const reads = pool();
    await reads.query("SELECT 1", {});
    const controller = new AbortController();
    const request = reads.query(slowSql, {}, { signal: controller.signal });
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    await reads.query("SELECT 1", {});
    vi.spyOn(slots(reads)[0].worker, "postMessage").mockImplementationOnce(() => {
      throw new Error("cannot post");
    });
    await expect(reads.query("SELECT 2", {})).rejects.toThrow("cannot post");
    expect(reads.stats()).toMatchObject({ pending: 0, pendingBytes: 0 });
    await expect(reads.query("SELECT 3 AS n", {})).resolves.toEqual([{ n: 3 }]);
  });

  it("fails overlarge results explicitly without returning partial rows", async () => {
    const reads = pool();
    await expect(
      reads.query("SELECT * FROM items", {}, { maxResultRows: 1 }),
    ).rejects.toMatchObject({ code: "RESULT_LIMIT" });
    await expect(
      reads.query("SELECT * FROM items", {}, { maxResultBytes: 1 }),
    ).rejects.toMatchObject({ code: "RESULT_LIMIT" });
    await expect(reads.query("SELECT * FROM items", {})).resolves.toHaveLength(2);
  });

  it("limits query payloads and rejects uncloneable parameters without retaining requests", async () => {
    const reads = pool({ maxPendingBytes: 100 });
    await expect(reads.query("SELECT @value", { value: "x".repeat(100) })).rejects.toMatchObject({
      code: "OVERLOADED",
    });
    await expect(reads.query("SELECT @value", { value: () => {} })).rejects.toThrow();
    expect(reads.stats()).toMatchObject({ pending: 0, pendingBytes: 0 });
  });

  it("snapshots queued parameters and limits before caller mutation", async () => {
    const reads = pool({ maxPendingBytes: 1000 });
    await reads.query("SELECT 1", {});
    const active = reads.query(slowSql, {});
    const params = { value: "small" };
    const options = { maxResultRows: 1 };
    const value = reads.query("SELECT @value AS value", params);
    const limited = reads.query("SELECT * FROM items", {}, options);
    const rejection = expect(limited).rejects.toMatchObject({ code: "RESULT_LIMIT" });
    const accounted = reads.stats().pendingBytes;
    params.value = "x".repeat(1_000_000);
    options.maxResultRows = Number.NaN;
    expect(reads.stats().pendingBytes).toBe(accounted);
    await active;
    await expect(value).resolves.toEqual([{ value: "small" }]);
    await rejection;
    expect(reads.stats().pendingBytes).toBe(0);
  });

  it("rejects pending and new requests when closed, including during startup", async () => {
    const reads = pool();
    const rejection = expect(reads.query("SELECT 1", {})).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await reads.close();
    await rejection;
    await expect(reads.query("SELECT 1", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(reads.stats()).toMatchObject({ closed: true, pending: 0, pendingBytes: 0 });
  });

  it("times out queries when a worker cannot initialize and closes restart timers", async () => {
    const reads = new SqliteReadPool(join(directory, "missing.db"), 1, {
      timeoutMs: 50,
      restartDelayMs: 10,
    });
    pools.push(reads);
    await expect(reads.query("SELECT 1", {})).rejects.toMatchObject({ code: "TIMEOUT" });
    await reads.close();
    expect(reads.stats().pending).toBe(0);
  });
});

it("applies ambient cancellation and result limits to synchronous fallback queries", async () => {
  vi.stubEnv("PERIFUSE_READ_WORKERS", "0");
  const db = new SQLiteTelemetryAdapter(dbPath);
  adapters.push(db);
  const controller = new AbortController();
  controller.abort();
  await expect(
    withTelemetryQuerySignal(controller.signal, () => db.query({ query: "SELECT 1" })),
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(db.query({ query: "SELECT * FROM items", maxResultRows: 1 })).rejects.toMatchObject({
    code: "RESULT_LIMIT",
  });
  await expect(db.query({ query: "SELECT * FROM items" })).resolves.toHaveLength(2);
});
