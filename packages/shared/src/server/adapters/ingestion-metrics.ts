import type { LocalExecutor } from "../../db/local";
import {
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "./trace-metrics-sql";

const metricColumns = `project_id, trace_id, user_id, session_id, obs_count,
      total_cost, input_cost, output_cost, input_tokens, output_tokens, total_tokens,
      cached_tokens, cache_creation_tokens, gross_input_tokens, timestamp`;
const additiveColumns = [
  "obs_count",
  "total_cost",
  "input_cost",
  "output_cost",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_tokens",
  "cache_creation_tokens",
  "gross_input_tokens",
];
export type ObservationMetric = Record<(typeof additiveColumns)[number], number>;

function metricSelect(extraWhere = ""): string {
  return `SELECT o.project_id, o.trace_id, t.user_id, t.session_id, COUNT(*) AS obs_count,
      COALESCE(SUM(o.total_cost), 0) AS total_cost,
      COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.input'), 0)), 0) AS input_cost,
      COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.output'), 0)), 0) AS output_cost,
      COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.input'), 0)), 0) AS input_tokens,
      COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.output'), 0)), 0) AS output_tokens,
      COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.total'),
        COALESCE(json_extract(o.usage_details, '$.input'), 0) +
        COALESCE(json_extract(o.usage_details, '$.output'), 0))), 0) AS total_tokens,
      ${TRACE_METRICS_CACHED_TOKENS_SQL} AS cached_tokens,
      ${TRACE_METRICS_CACHE_CREATION_TOKENS_SQL} AS cache_creation_tokens,
      ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL} AS gross_input_tokens, t.timestamp
    FROM observations o
    LEFT JOIN traces t ON t.project_id=o.project_id AND t.id=o.trace_id
    WHERE o.project_id=@projectId AND o.trace_id=@traceId AND o.is_deleted=0 ${extraWhere}
    GROUP BY o.project_id, o.trace_id
  `;
}

export async function readObservationMetric(
  db: LocalExecutor,
  projectId: string,
  traceId: string,
  observationId: string,
): Promise<ObservationMetric | undefined> {
  return db.get(metricSelect("AND o.id=@observationId"), { projectId, traceId, observationId });
}

/** Returns false when a legacy trace has not been materialized yet. */
export async function updateIngestionMetricsDelta(
  db: LocalExecutor,
  projectId: string,
  traceId: string,
  before: ObservationMetric,
  after: ObservationMetric,
): Promise<boolean> {
  const delta = Object.fromEntries(
    additiveColumns.map((column) => [column, after[column] - before[column]]),
  );
  const result = await db.run(
    `UPDATE trace_metrics SET ${additiveColumns.map((column) => `${column}=COALESCE(${column},0)+@${column}`).join(",")}
     WHERE project_id=@projectId AND trace_id=@traceId`,
    { projectId, traceId, ...delta },
  );
  return Number(result.changes) > 0;
}

/** Remove one previously counted observation, including its final empty aggregate row. */
export async function removeIngestionMetrics(
  db: LocalExecutor,
  projectId: string,
  traceId: string,
  previous: ObservationMetric,
): Promise<boolean> {
  const result = await db.run(
    `UPDATE trace_metrics SET ${additiveColumns.map((column) => `${column}=COALESCE(${column},0)-@${column}`).join(",")}
     WHERE project_id=@projectId AND trace_id=@traceId`,
    { projectId, traceId, ...previous },
  );
  if (!Number(result.changes)) return false;
  await db.run(
    "DELETE FROM trace_metrics WHERE project_id=? AND trace_id=? AND obs_count<=0",
    projectId,
    traceId,
  );
  return true;
}

/** Append a newly created observation in constant time, using the same SQL expressions as rebuilds. */
export async function addIngestionMetrics(
  db: LocalExecutor,
  projectId: string,
  traceId: string,
  observationId: string,
): Promise<void> {
  await db.run(
    `INSERT INTO trace_metrics (${metricColumns})
    ${metricSelect("AND o.id=@observationId")}
    ON CONFLICT(project_id,trace_id) DO UPDATE SET
      ${additiveColumns.map((column) => `${column}=trace_metrics.${column}+excluded.${column}`).join(",")},
      user_id=excluded.user_id,session_id=excluded.session_id,timestamp=excluded.timestamp`,
    { projectId, traceId, observationId },
  );
}

/** 在实体写事务内调用；先删除保证最后一个 observation 移走后不残留汇总。 */
export async function refreshIngestionMetrics(
  db: LocalExecutor,
  projectId: string,
  traceId: string,
): Promise<void> {
  const params = { projectId, traceId };
  await db.run(
    "DELETE FROM trace_metrics WHERE project_id=@projectId AND trace_id=@traceId",
    params,
  );
  await db.run(`INSERT INTO trace_metrics (${metricColumns}) ${metricSelect()}`, params);
}
