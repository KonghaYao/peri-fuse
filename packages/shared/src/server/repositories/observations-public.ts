import { isLiteMode } from "../adapters";
import { convertDateToClickhouseDateTime } from "../clickhouse/client";
import type { FilterList } from "../queries";
import { shouldSkipObservationsFinal } from "../queries/clickhouse-sql/query-options";
import { queryClickhouse } from "./clickhouse";
import type { ObservationRecordReadType } from "./definitions";
import { liteGetObservationsTable, liteGetObservationsTableCount } from "./lite-queries";
import { convertObservation } from "./observations_converters";

/**
 * Get observation counts grouped by project and day within a date range.
 *
 * Returns one row per project per day with the count of observations started on that day.
 * Uses half-open interval [startDate, endDate) for filtering based on start_time.
 *
 * @param startDate - Start of date range (inclusive)
 * @param endDate - End of date range (exclusive)
 * @returns Array of { count, projectId, date } objects
 *
 * @example
 * // Get observation counts for March 1-2, 2024
 * const counts = await getObservationCountsByProjectAndDay({
 *   startDate: new Date('2024-03-01T00:00:00Z'),
 *   endDate: new Date('2024-03-03T00:00:00Z')
 * });
 *
 * Note: Skips using FINAL (double counting risk) for faster and cheaper
 * queries against clickhouse. Generous 4x overcompensation before blocking allows
 * for usage aggregation to be meaningful.
 */
export const getObservationCountsByProjectAndDay = async ({
  startDate,
  endDate,
}: {
  startDate: Date;
  endDate: Date;
}) => {
  const query = `
    SELECT
      count(*) as count,
      project_id,
      toDate(start_time) as date
    FROM observations
    WHERE start_time >= {startDate: DateTime64(3)}
    AND start_time < {endDate: DateTime64(3)}
    GROUP BY project_id, toDate(start_time)
  `;

  const rows = await queryClickhouse<{
    count: string;
    project_id: string;
    date: string;
  }>({
    query,
    params: {
      startDate: convertDateToClickhouseDateTime(startDate),
      endDate: convertDateToClickhouseDateTime(endDate),
    },
    clickhouseConfigs: { request_timeout: 120_000 },
  });

  return rows.map((row) => ({
    count: Number(row.count),
    projectId: row.project_id,
    date: row.date,
  }));
};

/**
 * Get total cost grouped by evaluator ID (job_configuration_id) for the last week.
 *
 * @param projectId - Project ID
 * @param evaluatorIds - Array of evaluator IDs (job_configuration_id from metadata)
 * @returns Array of { evaluatorId, totalCost } objects
 */
export const getCostByEvaluatorIds = async (
  projectId: string,
  evaluatorIds: string[],
): Promise<Array<{ evaluatorId: string; totalCost: number }>> => {
  if (evaluatorIds.length === 0) return [];

  const query = `
    SELECT
      metadata['job_configuration_id'] as evaluator_id,
      sum(total_cost) as total_cost
    FROM observations FINAL
    WHERE project_id = {projectId: String}
      AND metadata['job_configuration_id'] IN ({evaluatorIds: Array(String)})
      AND type = 'GENERATION'
      AND start_time > today() - 7
    GROUP BY metadata['job_configuration_id']
  `;

  const rows = await queryClickhouse<{
    evaluator_id: string;
    total_cost: string;
  }>({
    query,
    params: {
      projectId,
      evaluatorIds,
    },
    tags: { projectId },
  });

  return rows.map((row) => ({
    evaluatorId: row.evaluator_id,
    totalCost: Number(row.total_cost),
  }));
};

// ─── Public-API observation query helpers ─────────────────────────────────────

export const generateObservationsForPublicApi = async ({
  projectId,
  filter,
  pagination,
}: {
  projectId: string;
  filter: FilterList;
  pagination: { limit: number; page: number };
}) => {
  // Lite mode: use SQLite queries
  if (isLiteMode()) {
    const records = await liteGetObservationsTable(
      projectId,
      pagination.limit,
      pagination.page - 1,
      filter,
    );
    return records.map((r) => convertObservation({ ...r, metadata: r.metadata ?? {} }));
  }

  const appliedFilter = filter.apply();
  const traceFilter = filter.find((f) => f.clickhouseTable === "traces");

  const disableObservationsFinal = await shouldSkipObservationsFinal(projectId);

  const query = `
    with clickhouse_keys as (
      SELECT DISTINCT
        id,
        trace_id,
        project_id,
        type,
        toDate(start_time)
      FROM observations o
        ${traceFilter ? `LEFT JOIN __TRACE_TABLE__ t ON o.trace_id = t.id AND t.project_id = o.project_id` : ""}
      WHERE o.project_id = {projectId: String}
        ${traceFilter ? `AND t.project_id = {projectId: String}` : ""}
        AND ${appliedFilter.query}
      ORDER BY start_time DESC
        LIMIT {limit: Int32} OFFSET {offset: Int32}
    )
    SELECT
      id,
      trace_id,
      project_id,
      type,
      parent_observation_id,
      environment,
      start_time,
      end_time,
      name,
      metadata,
      level,
      status_message,
      version,
      input,
      output,
      provided_model_name,
      internal_model_id,
      model_parameters,
      provided_usage_details,
      usage_details,
      provided_cost_details,
      cost_details,
      total_cost,
      completion_start_time,
      prompt_id,
      prompt_name,
      prompt_version,
      created_at,
      updated_at,
      event_ts
    FROM observations o ${disableObservationsFinal ? "" : "FINAL"}
    WHERE o.project_id = {projectId: String}
      AND (id, trace_id, project_id, type, toDate(start_time)) in (select * from clickhouse_keys)
    ORDER BY start_time DESC
  `;

  const input = {
    params: {
      ...appliedFilter.params,
      projectId,
      limit: pagination.limit,
      offset: (pagination.page - 1) * pagination.limit,
    },
    tags: { projectId },
  };

  const result = await queryClickhouse<ObservationRecordReadType>({
    query: query.replace("__TRACE_TABLE__", "traces"),
    params: input.params,
    tags: input.tags,
    preferredClickhouseService: "ReadOnly",
  });
  return result.map((r) => convertObservation(r));
};

export const getObservationsCountForPublicApi = async ({
  projectId,
  filter,
}: {
  projectId: string;
  filter: FilterList;
}) => {
  // Lite mode: return count from SQLite
  if (isLiteMode()) {
    return liteGetObservationsTableCount(projectId, filter);
  }

  const appliedFilter = filter.apply();
  const traceFilter = filter.find((f) => f.clickhouseTable === "traces");

  const query = `
    SELECT count() as count
    FROM observations o
    ${traceFilter ? `LEFT JOIN __TRACE_TABLE__ t ON o.trace_id = t.id AND t.project_id = o.project_id` : ""}
    WHERE o.project_id = {projectId: String}
    ${traceFilter ? `AND t.project_id = {projectId: String}` : ""}
    AND ${appliedFilter.query}
  `;

  const records = await queryClickhouse<{ count: string }>({
    query: query.replace("__TRACE_TABLE__", "traces"),
    params: { ...appliedFilter.params, projectId },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });
  return records.map((record) => Number(record.count)).shift();
};
