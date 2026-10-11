/**
 * Bun smoke for the SQLite read pool on the `bun:sqlite` engine.
 *
 * Vitest cannot load this worker path under Bun (its fork loader breaks zod
 * named exports), so the read pool is verified with a direct `bun run` script
 * instead. It keeps the writer connection open while the pool's readonly
 * workers read the same file, which would fail loudly if the two sides used
 * different engines (`bun:sqlite` cannot share a file with Turso's
 * multiprocess WAL).
 *
 * Usage:
 *   cd packages/shared
 *   PERIFUSE_ENGINE=sqlite bun run scripts/sqlite-read-pool-smoke.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The env schema requires a mode; the dynamic imports below must see it first.
process.env.LANGFUSE_MODE ??= "lite";

const { openLocalDatabase, resolveLocalEngine } = await import("../src/db/local");
const { SqliteReadPool } = await import("../src/server/adapters/sqlite-read-pool");

const onBun = typeof process.versions.bun === "string";
assert.ok(onBun, "This smoke requires the Bun runtime");
assert.equal(resolveLocalEngine(), "sqlite", "run with PERIFUSE_ENGINE=sqlite");

const directory = mkdtempSync(join(tmpdir(), "perifuse-read-pool-smoke-"));
const dbPath = join(directory, "smoke.db");
const writer = await openLocalDatabase(dbPath);
const pool = new SqliteReadPool(dbPath, 1, { restartDelayMs: 10 });

try {
  await writer.exec("CREATE TABLE items (value TEXT)");
  await writer.exec("INSERT INTO items VALUES ('hello'), ('world')");

  // The writer connection stays open: a mismatched engine in the workers would
  // fail here instead of silently reading through a second driver.
  assert.deepEqual(await pool.query("SELECT value FROM items ORDER BY rowid", {}), [
    { value: "hello" },
    { value: "world" },
  ]);
  console.log("rows:", "read while the writer connection is open");

  const limited = await pool
    .query("SELECT value FROM items", {}, { maxResultRows: 1 })
    .then(() => undefined)
    .catch((error: { code?: string }) => error);
  assert.equal(limited?.code, "RESULT_LIMIT", "row limits must be enforced in the worker");
  console.log("limits:", "RESULT_LIMIT enforced");

  const write = await pool
    .query("INSERT INTO items VALUES ('forbidden')", {})
    .then(() => undefined)
    .catch((error: { message?: string; code?: string }) => error);
  assert.ok(write, "readonly workers must not accept writes");
  console.log("readonly:", write.code ?? write.message);

  const cancelled = await pool
    .query(
      "SELECT SUM(x) FROM (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT x FROM n)",
      {},
      { timeoutMs: 50 },
    )
    .then(() => undefined)
    .catch((error: { name?: string }) => error);
  assert.ok(cancelled, "timeouts must reject the request");
  assert.deepEqual(await pool.query("SELECT 3 AS n", {}), [{ n: 3 }]);
  const stats = pool.stats();
  assert.equal(stats.pending, 0);
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.pendingBytes, 0);
  console.log("recovery:", "worker replaced after timeout, pool drained");
} finally {
  await pool.close();
  await writer.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log("sqlite read pool smoke: OK");
