import {
  getTelemetryDB,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "@peri-fuse/shared/src/server/adapters";
import { toMs } from "./trace-metrics";

type AggregateRow = {
  trace_id: string;
  starts: number;
  first: string | null;
  last: string | null;
  ended: string | null;
  prompt: number;
  completion: number;
  tokens: number;
  cached: number;
  gross: number;
  cost: number;
  fallback_cost: number;
};

/** Aggregate in SQLite so a trace with many spans still returns one metric row. */
export async function getSessionTraceMetrics(projectId: string, traceIds: string[]) {
  const rows: AggregateRow[] = [];
  const db = getTelemetryDB();
  // Default SDK responses can contain more IDs than SQLite's parameter limit.
  for (let offset = 0; offset < traceIds.length; offset += 500) {
    const batch = traceIds.slice(offset, offset + 500);
    const params: Record<string, unknown> = { projectId };
    batch.forEach((id, index) => {
      params[`id${index}`] = id;
    });
    rows.push(
      ...(await db.query<AggregateRow>({
        query: `SELECT o.trace_id, COUNT(o.start_time) AS starts,
        MIN(o.start_time) AS first, MAX(o.start_time) AS last, MAX(o.end_time) AS ended,
        SUM(COALESCE(json_extract(o.usage_details, '$.input'), 0)) AS prompt,
        SUM(COALESCE(json_extract(o.usage_details, '$.output'), 0)) AS completion,
        SUM(COALESCE(json_extract(o.usage_details, '$.total'),
          COALESCE(json_extract(o.usage_details, '$.input'), 0) +
          COALESCE(json_extract(o.usage_details, '$.output'), 0))) AS tokens,
        ${TRACE_METRICS_CACHED_TOKENS_SQL} AS cached,
        ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL} AS gross,
        SUM(COALESCE(o.total_cost, json_extract(o.cost_details, '$.total'), 0)) AS cost,
        SUM(COALESCE(json_extract(o.cost_details, '$.input'), 0) +
          COALESCE(json_extract(o.cost_details, '$.output'), 0)) AS fallback_cost
        FROM observations o WHERE o.project_id = @projectId
          AND o.trace_id IN (${batch.map((_, i) => `@id${i}`).join(",")}) AND o.is_deleted = 0
        GROUP BY o.trace_id`,
        params,
      })),
    );
  }
  return new Map(
    rows.map((row) => {
      const first = toMs(row.first);
      const last = toMs(row.ended) ?? (row.starts > 1 ? toMs(row.last) : null);
      return [
        row.trace_id,
        {
          latency: first !== null && last !== null ? (last - first) / 1000 : null,
          promptTokens: row.prompt ?? 0,
          completionTokens: row.completion ?? 0,
          totalTokens: row.tokens ?? 0,
          cachedTokens: row.cached ?? 0,
          cacheHitRate: row.gross > 0 ? row.cached / row.gross : 0,
          totalCost: row.cost > 0 ? row.cost : row.fallback_cost > 0 ? row.fallback_cost : null,
        },
      ];
    }),
  );
}
