import type { LocalExecutor } from "../../db/local";
import {
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "./trace-metrics-sql";

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
  await db.run(
    `
    INSERT INTO trace_metrics (project_id, trace_id, user_id, session_id, obs_count,
      total_cost, input_cost, output_cost, input_tokens, output_tokens, total_tokens,
      cached_tokens, cache_creation_tokens, gross_input_tokens, timestamp)
    SELECT o.project_id, o.trace_id, t.user_id, t.session_id, COUNT(*),
      COALESCE(SUM(o.total_cost), 0),
      COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.input'), 0)), 0),
      COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.output'), 0)), 0),
      COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.input'), 0)), 0),
      COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.output'), 0)), 0),
      COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.total'),
        COALESCE(json_extract(o.usage_details, '$.input'), 0) +
        COALESCE(json_extract(o.usage_details, '$.output'), 0))), 0),
      ${TRACE_METRICS_CACHED_TOKENS_SQL},
      ${TRACE_METRICS_CACHE_CREATION_TOKENS_SQL},
      ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL}, t.timestamp
    FROM observations o
    LEFT JOIN traces t ON t.project_id=o.project_id AND t.id=o.trace_id
    WHERE o.project_id=@projectId AND o.trace_id=@traceId AND o.is_deleted=0
    GROUP BY o.project_id, o.trace_id
  `,
    params,
  );
}
