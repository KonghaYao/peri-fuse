import { convertDateToClickhouseDateTime } from "../clickhouse/client";
import { parseClickhouseUTCDateTimeFormat, queryClickhouse } from "./clickhouse";

export const getObservationsWithPromptName = async (
  projectId: string,
  promptNames: string[],
  { fromTimestamp, toTimestamp }: { fromTimestamp?: Date; toTimestamp?: Date } = {},
) => {
  const query = `
  SELECT uniq(id) as count, prompt_name
  FROM observations
  WHERE project_id = {projectId: String}
  AND prompt_name IN ({promptNames: Array(String)})
  AND prompt_name IS NOT NULL
  ${fromTimestamp ? "AND start_time >= {fromTimestamp: DateTime64(3)}" : ""}
  ${toTimestamp ? "AND start_time <= {toTimestamp: DateTime64(3)}" : ""}
  GROUP BY prompt_name
`;
  const rows = await queryClickhouse<{ count: string; prompt_name: string }>({
    query: query,
    params: {
      projectId,
      promptNames,
      fromTimestamp: fromTimestamp ? convertDateToClickhouseDateTime(fromTimestamp) : undefined,
      toTimestamp: toTimestamp ? convertDateToClickhouseDateTime(toTimestamp) : undefined,
    },
    tags: { projectId },
  });

  return rows.map((r) => ({
    count: Number(r.count),
    promptName: r.prompt_name,
  }));
};

export const getObservationMetricsForPrompts = async (
  projectId: string,
  promptIds: string[],
  { fromTimestamp, toTimestamp }: { fromTimestamp?: Date; toTimestamp?: Date } = {},
) => {
  const query = `
      WITH latencies AS
          (
              SELECT
                  prompt_id,
                  prompt_version,
                  start_time,
                  end_time,
                  usage_details,
                  cost_details,
                  dateDiff('millisecond', start_time, end_time) AS latency_ms
              FROM observations
              FINAL
              WHERE (type = 'GENERATION')
              AND (prompt_name IS NOT NULL)
              AND project_id={projectId: String}
              AND prompt_id IN ({promptIds: Array(String)})
              ${fromTimestamp ? "AND start_time >= {fromTimestamp: DateTime64(3)}" : ""}
              ${toTimestamp ? "AND start_time <= {toTimestamp: DateTime64(3)}" : ""}
          )
      SELECT
          count(*) AS count,
          prompt_id,
          prompt_version,
          min(start_time) AS first_observation,
          max(start_time) AS last_observation,
          medianExact(arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, usage_details)))) AS median_input_usage,
          medianExact(arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, usage_details)))) AS median_output_usage,
          medianExact(cost_details['total']) AS median_total_cost,
          medianExact(latency_ms) AS median_latency_ms
      FROM latencies
      GROUP BY
          prompt_id,
          prompt_version
      ORDER BY prompt_version DESC
`;
  const rows = await queryClickhouse<{
    count: string;
    prompt_id: string;
    prompt_version: number;
    first_observation: string;
    last_observation: string;
    median_input_usage: string;
    median_output_usage: string;
    median_total_cost: string;
    median_latency_ms: string;
  }>({
    query: query,
    params: {
      projectId,
      promptIds,
      ...(fromTimestamp ? { fromTimestamp: convertDateToClickhouseDateTime(fromTimestamp) } : {}),
      ...(toTimestamp ? { toTimestamp: convertDateToClickhouseDateTime(toTimestamp) } : {}),
    },
    tags: { projectId },
  });

  return rows.map((r) => ({
    count: Number(r.count),
    promptId: r.prompt_id,
    promptVersion: r.prompt_version,
    firstObservation: parseClickhouseUTCDateTimeFormat(r.first_observation),
    lastObservation: parseClickhouseUTCDateTimeFormat(r.last_observation),
    medianInputUsage: Number(r.median_input_usage),
    medianOutputUsage: Number(r.median_output_usage),
    medianTotalCost: Number(r.median_total_cost),
    medianLatencyMs: Number(r.median_latency_ms),
  }));
};

export const getLatencyAndTotalCostForObservations = async (
  projectId: string,
  observationIds: string[],
  timestamp?: Date,
) => {
  const query = `
    SELECT
        id,
        cost_details['total'] AS total_cost,
        dateDiff('millisecond', start_time, end_time) AS latency_ms
    FROM observations FINAL
    WHERE project_id = {projectId: String}
    AND id IN ({observationIds: Array(String)})
    ${timestamp ? `AND start_time >= {timestamp: DateTime64(3)}` : ""}
`;
  const rows = await queryClickhouse<{
    id: string;
    total_cost: string;
    latency_ms: string;
  }>({
    query: query,
    params: {
      projectId,
      observationIds,
      ...(timestamp ? { timestamp: convertDateToClickhouseDateTime(timestamp) } : {}),
    },
    tags: { projectId },
  });

  return rows.map((r) => ({
    id: r.id,
    totalCost: Number(r.total_cost),
    latency: Number(r.latency_ms) / 1000,
  }));
};

export const getLatencyAndTotalCostForObservationsByTraces = async (
  projectId: string,
  traceIds: string[],
  timestamp?: Date,
) => {
  const query = `
    SELECT
        trace_id,
        sumMap(cost_details)['total'] AS total_cost,
        dateDiff('millisecond', min(start_time), max(end_time)) AS latency_ms
    FROM observations FINAL
    WHERE project_id = {projectId: String}
    AND trace_id IN ({traceIds: Array(String)})
    ${timestamp ? `AND start_time >= {timestamp: DateTime64(3)}` : ""}
    GROUP BY trace_id
`;
  const rows = await queryClickhouse<{
    trace_id: string;
    total_cost: string;
    latency_ms: string;
  }>({
    query: query,
    params: {
      projectId,
      traceIds,
      ...(timestamp ? { timestamp: convertDateToClickhouseDateTime(timestamp) } : {}),
    },
    tags: { projectId },
  });

  return rows.map((r) => ({
    traceId: r.trace_id,
    totalCost: Number(r.total_cost),
    latency: Number(r.latency_ms) / 1000,
  }));
};

/**
 * Tuple type for observation data from ClickHouse groupArray
 */
export type ObservationTuple = [
  id: string,
  parentObservationId: string | null,
  totalCost: string,
  inputCost: string,
  outputCost: string,
  latencyMs: number,
];

/**
 * Get observations grouped by trace ID with cost and latency data
 *
 * This is a pure data-fetching function that returns observations organized by trace.
 * For business logic like recursive cost calculations, use the utility functions
 * in the utils layer.
 */
export const getObservationsGroupedByTraceId = async (
  projectId: string,
  traceIds: string[],
  timestamp?: Date,
): Promise<Map<string, ObservationTuple[]>> => {
  if (traceIds.length === 0) return new Map();

  const query = `
    SELECT
        trace_id,
        groupArray((
          id,
          parent_observation_id,
          cost_details['total'],
          cost_details['input'],
          cost_details['output'],
          dateDiff('millisecond', start_time, end_time)
        )) AS observations
    FROM observations FINAL
    WHERE project_id = {projectId: String}
    AND trace_id IN ({traceIds: Array(String)})
    ${timestamp ? `AND start_time >= {timestamp: DateTime64(3)}` : ""}
    GROUP BY trace_id
  `;

  const groupedObservations = await queryClickhouse<{
    trace_id: string;
    observations: ObservationTuple[];
  }>({
    query,
    params: {
      projectId,
      traceIds,
      ...(timestamp ? { timestamp: convertDateToClickhouseDateTime(timestamp) } : {}),
    },
    tags: { projectId },
  });

  return new Map(groupedObservations.map((g) => [g.trace_id, g.observations]));
};

export const getObservationCountsByProjectInCreationInterval = async ({
  start,
  end,
}: {
  start: Date;
  end: Date;
}) => {
  const query = `
    SELECT
      project_id,
      count(*) as count
    FROM observations
    WHERE created_at >= {start: DateTime64(3)}
    AND created_at < {end: DateTime64(3)}
    GROUP BY project_id
  `;

  const rows = await queryClickhouse<{ project_id: string; count: string }>({
    query,
    params: {
      start: convertDateToClickhouseDateTime(start),
      end: convertDateToClickhouseDateTime(end),
    },
    clickhouseConfigs: {
      request_timeout: 300000, // 5 minutes timeout
    },
  });

  return rows.map((row) => ({
    projectId: row.project_id,
    count: Number(row.count),
  }));
};

export const getObservationCountOfProjectsSinceCreationDate = async ({
  projectIds,
  start,
}: {
  projectIds: string[];
  start: Date;
}) => {
  const query = `
    SELECT
      count(*) as count
    FROM observations
    WHERE project_id IN ({projectIds: Array(String)})
    AND created_at >= {start: DateTime64(3)}
  `;

  const rows = await queryClickhouse<{ count: string }>({
    query,
    params: {
      projectIds,
      start: convertDateToClickhouseDateTime(start),
    },
  });

  return Number(rows[0]?.count ?? 0);
};

export const getTraceIdsForObservations = async (projectId: string, observationIds: string[]) => {
  const query = `
    SELECT
      trace_id,
      id
    FROM observations
    WHERE project_id = {projectId: String}
    AND id IN ({observationIds: Array(String)})
  `;

  const rows = await queryClickhouse<{ id: string; trace_id: string }>({
    query,
    params: {
      projectId,
      observationIds,
    },
    tags: { projectId },
  });

  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
  }));
};
