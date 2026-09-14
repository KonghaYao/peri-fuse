import { SqliteReadPool } from "../adapters/sqlite-read-pool";
import { TelemetryQueryError } from "../adapters/telemetry-query-context";
import type { TelemetryDBAdapter } from "../adapters/types";

const pools = new WeakMap<object, SqliteReadPool>();
const MAX_PENDING = 8;
const TIMEOUT_MS = 500;

/** Search reads use a single dedicated worker and bounded queue. */
export async function querySessionSearchRead<T>(
  adapter: TelemetryDBAdapter,
  sql: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = TIMEOUT_MS,
): Promise<T[]> {
  const dbPath = adapter.getDatabase?.().name;
  // In-memory databases are only used by explicit unit-test doubles.
  if (!dbPath && dbPath !== ":memory:")
    throw new TelemetryQueryError("UNAVAILABLE", "SQLite search database path is unavailable");
  if (dbPath === ":memory:")
    return adapter.query<T>({
      query: sql,
      params,
      signal,
      timeoutMs,
      maxResultRows: 1002,
      maxResultBytes: 2 * 1024 * 1024,
    });
  let pool = pools.get(adapter);
  if (!pool) {
    pool = new SqliteReadPool(dbPath, 1, { maxPending: MAX_PENDING, timeoutMs: TIMEOUT_MS });
    pools.set(adapter, pool);
  }
  return pool.query<T>(sql, params, {
    signal,
    timeoutMs,
    maxResultRows: 1002,
    maxResultBytes: 2 * 1024 * 1024,
  });
}
export async function stopSessionSearchReadPool(adapter: TelemetryDBAdapter): Promise<void> {
  const pool = pools.get(adapter);
  if (pool) {
    pools.delete(adapter);
    await pool.close();
  }
}
