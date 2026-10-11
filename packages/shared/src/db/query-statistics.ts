import type { Database } from "@tursodatabase/database";

/**
 * Query statistics maintenance for embedded Turso databases.
 *
 * The Turso planner misestimates equality constraints on a single member of a
 * composite primary key as a unique-column lookup (1 row) when no ANALYZE
 * statistics are available, which makes point lookups collapse into prefix
 * scans of a secondary index (upstream tursodatabase/turso#8664, tracked in
 * docs/issues/2026-10-11-p1-turso-planner-missing-statistics.md).
 *
 * `ANALYZE` fixes the estimate through per-index prefix statistics, but only
 * once the table actually contains rows: empty tables get no `sqlite_stat1`
 * entries, so analyzing during migrations (when tables are empty) is a no-op.
 * This maintenance pass therefore waits until a table is non-empty and only
 * analyzes tables that have no usable per-index statistics yet.
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export type QueryStatisticsEvent =
  | { type: "analyzed"; tables: string[] }
  | { type: "error"; message: string };

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Tables whose per-index statistics exist with a positive row estimate. */
async function readAnalyzedTables(db: Database): Promise<Set<string>> {
  const analyzed = new Set<string>();
  let rows: { tbl?: unknown; idx?: unknown; stat?: unknown }[];
  try {
    rows = (await db.all("SELECT tbl, idx, stat FROM sqlite_stat1")) as typeof rows;
  } catch {
    return analyzed; // sqlite_stat1 does not exist yet
  }
  for (const row of rows) {
    if (typeof row.tbl !== "string" || typeof row.idx !== "string") continue; // table-level rows do not count
    const estimate = Number.parseInt(String(row.stat ?? "").split(" ")[0] ?? "", 10);
    if (Number.isFinite(estimate) && estimate > 0) analyzed.add(row.tbl);
  }
  return analyzed;
}

/**
 * Runs one maintenance pass: for every non-empty user table without usable
 * per-index statistics, execute a table-scoped ANALYZE. Returns analyzed tables.
 * Failures are swallowed per table; a later pass retries (e.g. lock contention).
 */
export async function ensureQueryStatistics(db: Database): Promise<string[]> {
  const analyzed: string[] = [];
  let tables: { name?: unknown }[];
  try {
    tables = (await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 7) <> 'sqlite_'",
    )) as typeof tables;
  } catch {
    return analyzed;
  }
  const alreadyAnalyzed = await readAnalyzedTables(db);
  for (const { name } of tables) {
    if (typeof name !== "string" || name.startsWith("_")) continue; // internal bookkeeping tables
    if (alreadyAnalyzed.has(name)) continue;
    try {
      const present = await db.get(`SELECT 1 AS present FROM ${quoteIdentifier(name)} LIMIT 1`);
      if (!present) continue; // ANALYZE records nothing for empty tables
      await db.exec(`ANALYZE ${quoteIdentifier(name)}`);
      analyzed.push(name);
    } catch {
      // retried on the next pass
    }
  }
  return analyzed;
}

/**
 * Starts periodic query-statistics maintenance: one pass immediately, then
 * every `intervalMs`. Once statistics are in place a pass is read-only and
 * effectively free. Returns a stop function.
 */
export function startQueryStatisticsMaintenance(
  db: Database,
  options: { intervalMs?: number; onEvent?: (event: QueryStatisticsEvent) => void } = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let running = false;
  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const analyzed = await ensureQueryStatistics(db);
      if (analyzed.length > 0) options.onEvent?.({ type: "analyzed", tables: analyzed });
    } catch (error) {
      options.onEvent?.({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
