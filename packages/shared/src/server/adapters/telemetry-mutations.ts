import type { LocalExecutor } from "../../db/local";
import { type SearchSource, SessionSearchStorage } from "../session-search/storage";
import {
  addIngestionMetrics,
  type ObservationMetric,
  readObservationMetric,
  refreshIngestionMetrics,
  removeIngestionMetrics,
  updateIngestionMetricsDelta,
} from "./ingestion-metrics";
import type { TelemetryQueryOpts } from "./types";

const entityTables = new Set(["traces", "observations", "scores"]);
export type MetricsToRefresh = {
  metrics: Map<string, [string, string]>;
  daily: Set<string>;
  search: Map<string, SearchSource>;
};

export function createMutationContext(): MetricsToRefresh {
  return { metrics: new Map(), daily: new Set(), search: new Map() };
}

export async function flushIngestionMetrics(
  tx: LocalExecutor,
  pending: MetricsToRefresh,
): Promise<void> {
  for (const [projectId, traceId] of pending.metrics.values())
    await refreshIngestionMetrics(tx, projectId, traceId);
  const search = new SessionSearchStorage(tx);
  for (const source of pending.search.values()) await search.markDirty(source);
}

export function mutationSnapshotColumns(table: string): string {
  if (table === "traces") return "id,project_id,timestamp,user_id,session_id,is_deleted";
  if (table === "observations") return "id,project_id,trace_id,start_time,type,is_deleted";
  return "id,project_id,trace_id,timestamp";
}
export function isTelemetryEntity(table: string): boolean {
  return entityTables.has(table);
}

export async function recordTelemetryMutation(
  tx: LocalExecutor,
  table: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
  pendingMetrics?: MetricsToRefresh,
  searchChanged = true,
  beforeMetric?: ObservationMetric,
): Promise<void> {
  if (!isTelemetryEntity(table)) return;
  const affected = new Map<string, Record<string, unknown>>();
  const dirtyDays = new Map<string, [string, string]>();
  for (const row of [before, after]) {
    if (!row) continue;
    const projectId = String(row.project_id);
    const time = row[table === "observations" ? "start_time" : "timestamp"];
    if (typeof time === "string") {
      const day = time.slice(0, 10);
      dirtyDays.set(JSON.stringify([projectId, day]), [projectId, day]);
    }
    affected.set(JSON.stringify([projectId, row.id]), row);
  }
  for (const [key, [projectId, day]] of dirtyDays) {
    if (pendingMetrics?.daily.has(key)) continue;
    await tx.run(
      `INSERT INTO daily_stats_dirty(project_id,day)
      SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM telemetry_retention_state WHERE ?<cutoff_day)
      ON CONFLICT(project_id,day) DO UPDATE SET revision=revision+1,dirty=1`,
      projectId,
      day,
      day,
    );
    pendingMetrics?.daily.add(key);
  }
  for (const row of affected.values()) {
    if (table !== "scores" && searchChanged) {
      const source: SearchSource = {
        projectId: String(row.project_id),
        kind: table === "traces" ? "trace" : "observation",
        id: String(row.id),
        revision: 0,
        eventTime: String(row[table === "observations" ? "start_time" : "timestamp"] ?? ""),
      };
      if (pendingMetrics)
        pendingMetrics.search.set(
          JSON.stringify([source.projectId, source.kind, source.id]),
          source,
        );
      else await new SessionSearchStorage(tx).markDirty(source);
    }
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
      traceKeys.set(JSON.stringify([row.project_id, traceId]), [String(row.project_id), traceId]);
  }
  for (const [key, pair] of traceKeys) {
    if (
      pendingMetrics &&
      table === "observations" &&
      after &&
      after.is_deleted !== 1 &&
      pair[0] === String(after.project_id) &&
      pair[1] === String(after.trace_id) &&
      (!before || before.is_deleted === 1 || before.trace_id !== after.trace_id) &&
      !pendingMetrics.metrics.has(key)
    ) {
      const materialized = await tx.get(
        "SELECT 1 FROM trace_metrics WHERE project_id=? AND trace_id=?",
        ...pair,
      );
      const unmaterialized =
        !materialized &&
        (await tx.get(
          "SELECT 1 FROM observations WHERE project_id=? AND trace_id=? AND id<>? AND is_deleted=0 LIMIT 1",
          ...pair,
          after.id,
        ));
      if (unmaterialized) pendingMetrics.metrics.set(key, pair);
      else await addIngestionMetrics(tx, pair[0], pair[1], String(after.id));
    } else if (
      pendingMetrics &&
      table === "observations" &&
      before &&
      beforeMetric &&
      before.is_deleted !== 1 &&
      pair[0] === String(before.project_id) &&
      pair[1] === String(before.trace_id) &&
      (!after || after.is_deleted === 1 || before.trace_id !== after.trace_id) &&
      !pendingMetrics.metrics.has(key)
    ) {
      if (!(await removeIngestionMetrics(tx, pair[0], pair[1], beforeMetric)))
        pendingMetrics.metrics.set(key, pair);
    } else if (
      pendingMetrics &&
      table === "observations" &&
      before &&
      after &&
      before.trace_id === after.trace_id &&
      before.is_deleted !== 1 &&
      after.is_deleted !== 1 &&
      beforeMetric &&
      !pendingMetrics.metrics.has(key)
    ) {
      const afterMetric = await readObservationMetric(tx, pair[0], pair[1], String(after.id));
      if (
        !afterMetric ||
        !(await updateIngestionMetricsDelta(tx, pair[0], pair[1], beforeMetric, afterMetric))
      )
        pendingMetrics.metrics.set(key, pair);
    } else if (
      pendingMetrics &&
      table === "traces" &&
      after &&
      pair[0] === String(after.project_id) &&
      pair[1] === String(after.id) &&
      !pendingMetrics.metrics.has(key)
    ) {
      const materialized = await tx.get(
        "SELECT 1 FROM trace_metrics WHERE project_id=? AND trace_id=?",
        ...pair,
      );
      const unmaterialized =
        !materialized &&
        (await tx.get(
          "SELECT 1 FROM observations WHERE project_id=? AND trace_id=? AND is_deleted=0 LIMIT 1",
          ...pair,
        ));
      if (unmaterialized) pendingMetrics.metrics.set(key, pair);
      else if (materialized)
        await tx.run(
          `UPDATE trace_metrics SET user_id=?,session_id=?,timestamp=?
         WHERE project_id=? AND trace_id=?`,
          after.user_id ?? null,
          after.session_id ?? null,
          after.timestamp ?? null,
          ...pair,
        );
    } else if (pendingMetrics) pendingMetrics.metrics.set(key, pair);
    else await refreshIngestionMetrics(tx, ...pair);
  }
}

export async function executeTelemetryCommand(
  tx: LocalExecutor,
  opts: TelemetryQueryOpts,
  pendingMetrics?: MetricsToRefresh,
): Promise<{ changes: number }> {
  const mutation = /^\s*(UPDATE|DELETE\s+FROM)\s+(traces|observations|scores)\b/i.exec(opts.query);
  if (!mutation) {
    const result = await tx.run(opts.query, opts.params ?? {});
    return { changes: Number(result.changes) };
  }
  const table = mutation[2].toLowerCase();
  const columns = mutationSnapshotColumns(table);
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
    await recordTelemetryMutation(tx, table, row, after, pendingMetrics);
  }
  return { changes: Number(result.changes) };
}
