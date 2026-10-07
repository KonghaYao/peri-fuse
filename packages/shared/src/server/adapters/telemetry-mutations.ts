import type { LocalExecutor } from "../../db/local";
import { SessionSearchStorage } from "../session-search/storage";
import { refreshIngestionMetrics } from "./ingestion-metrics";
import type { TelemetryQueryOpts } from "./types";

const entityTables = new Set(["traces", "observations", "scores"]);
export function isTelemetryEntity(table: string): boolean {
  return entityTables.has(table);
}

export async function recordTelemetryMutation(
  tx: LocalExecutor,
  table: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): Promise<void> {
  if (!isTelemetryEntity(table)) return;
  const affected = new Map<string, Record<string, unknown>>();
  for (const row of [before, after]) {
    if (!row) continue;
    const projectId = String(row.project_id);
    const time = row[table === "observations" ? "start_time" : "timestamp"];
    if (typeof time === "string") {
      const day = time.slice(0, 10);
      await tx.run(
        `INSERT INTO daily_stats_dirty(project_id,day)
        SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM telemetry_retention_state WHERE ?<cutoff_day)
        ON CONFLICT(project_id,day) DO UPDATE SET revision=revision+1,dirty=1`,
        projectId,
        day,
        day,
      );
    }
    affected.set(`${projectId}:${row.id}`, row);
  }
  for (const row of affected.values()) {
    if (table !== "scores")
      await new SessionSearchStorage(tx).markDirty({
        projectId: String(row.project_id),
        kind: table === "traces" ? "trace" : "observation",
        id: String(row.id),
        revision: 0,
        eventTime: String(row[table === "observations" ? "start_time" : "timestamp"] ?? ""),
      });
    if (!after)
      await tx.run(
        "DELETE FROM ingestion_field_versions WHERE project_id=? AND entity_type=? AND entity_id=?",
        row.project_id,
        table,
        row.id,
      );
  }
  const traceKeys = new Map<string, [string, string]>();
  for (const row of [before, after]) {
    const traceId = table === "traces" ? row?.id : row?.trace_id;
    if (row && typeof traceId === "string" && table !== "scores")
      traceKeys.set(`${row.project_id}:${traceId}`, [String(row.project_id), traceId]);
  }
  for (const [projectId, traceId] of traceKeys.values())
    await refreshIngestionMetrics(tx, projectId, traceId);
}

export async function executeTelemetryCommand(
  tx: LocalExecutor,
  opts: TelemetryQueryOpts,
): Promise<{ changes: number }> {
  const mutation = /^\s*(UPDATE|DELETE\s+FROM)\s+(traces|observations|scores)\b/i.exec(opts.query);
  if (!mutation) {
    const result = await tx.run(opts.query, opts.params ?? {});
    return { changes: Number(result.changes) };
  }
  const table = mutation[2].toLowerCase();
  const columns =
    table === "traces"
      ? "id,project_id,timestamp"
      : table === "observations"
        ? "id,project_id,trace_id,start_time"
        : "id,project_id,trace_id,timestamp";
  const where = opts.query
    .slice(mutation[0].length)
    .match(/\bWHERE\b([\s\S]*)/i)?.[1]
    ?.replace(/;\s*$/, "");
  const before = (await tx.all(
    `SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ""}`,
    opts.params ?? {},
  )) as Record<string, unknown>[];
  const result = await tx.run(opts.query, opts.params ?? {});
  for (const row of before) {
    const after =
      mutation[1].toUpperCase() === "UPDATE"
        ? await tx.get(
            `SELECT ${columns} FROM ${table} WHERE project_id=? AND id=?`,
            row.project_id,
            row.id,
          )
        : undefined;
    await recordTelemetryMutation(tx, table, row, after);
  }
  return { changes: Number(result.changes) };
}
