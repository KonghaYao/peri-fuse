/**
 * Lite-mode upsert – bridges the `upsertClickhouse` interface to SQLite.
 *
 * When `upsertClickhouse()` is called in lite mode, it delegates here.
 * We map records through the same `eventBodyMapper` used by the full-mode
 * S3/ClickHouse path, then INSERT OR REPLACE into the SQLite telemetry DB.
 */

import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";

type UpsertOpts = {
  table: "scores" | "traces" | "observations";
  records: Record<string, unknown>[];
  eventBodyMapper: (body: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Serialize a value for SQLite storage:
 * - Objects/Arrays → JSON string
 * - Dates → ISO string
 * - Booleans → 0/1
 * - null/undefined → null
 * - primitives → as-is
 */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Map a raw record to SQLite-compatible row format.
 * Handles JSON serialization for complex fields.
 */
function toSqliteRow(record: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    row[key] = serializeValue(value);
  }
  // Ensure timestamps are set
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  if (!row.created_at) row.created_at = now;
  if (!row.updated_at) row.updated_at = now;
  if (!row.event_ts) row.event_ts = now;
  return row;
}

/**
 * Lite-mode upsert: writes records to SQLite via the TelemetryDBAdapter.
 */
export async function liteUpsert(opts: UpsertOpts): Promise<void> {
  const db = getTelemetryDB();
  const rows: Record<string, unknown>[] = [];

  for (const record of opts.records) {
    try {
      const mapped = opts.eventBodyMapper(record);
      const row = toSqliteRow(mapped);
      rows.push(row);
    } catch (error) {
      logger.warn("[liteUpsert] Failed to map record, skipping", {
        table: opts.table,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (rows.length === 0) return;

  try {
    await db.insert({ table: opts.table, records: rows });
  } catch (error) {
    logger.error(`[liteUpsert] Failed to insert into ${opts.table}`, {
      error: error instanceof Error ? error.message : String(error),
      rowCount: rows.length,
    });
    // Don't throw – ingestion should not fail hard in lite mode
  }
}
