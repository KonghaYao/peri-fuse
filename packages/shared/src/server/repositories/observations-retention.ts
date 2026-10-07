import { env } from "../../env";
import { convertDateToClickhouseDateTime } from "../clickhouse/client";
import { logger } from "../logger";
import { commandClickhouse, queryClickhouse } from "./clickhouse";
import { OBSERVATIONS_TO_TRACE_INTERVAL } from "./constants";

export const getCostForTraces = async (projectId: string, timestamp: Date, traceIds: string[]) => {
  // Wrapping the query in a CTE allows us to skip FINAL which allows Clickhouse to use skip indexes.
  const query = `
    WITH selected_observations AS (
      SELECT o.total_cost as total_cost
      FROM observations o
      WHERE o.project_id = {projectId: String}
      AND o.trace_id IN ({traceIds: Array(String)})
      AND o.start_time >= {timestamp: DateTime64(3)} - ${OBSERVATIONS_TO_TRACE_INTERVAL}
      ORDER BY o.event_ts DESC
      LIMIT 1 BY o.id, o.project_id
    )

    SELECT sum(total_cost) as total_cost
    FROM selected_observations
 `;

  const res = await queryClickhouse<{ total_cost: string }>({
    query,
    params: {
      projectId,
      traceIds,
      timestamp: convertDateToClickhouseDateTime(timestamp),
    },
    tags: { projectId },
  });
  return res.length > 0 ? Number(res[0].total_cost) : undefined;
};

export const deleteObservationsByTraceIds = async (projectId: string, traceIds: string[]) => {
  const preflight = await queryClickhouse<{
    min_ts: string;
    max_ts: string;
    cnt: string;
  }>({
    query: `
      SELECT
        min(start_time) - INTERVAL 1 HOUR as min_ts,
        max(start_time) + INTERVAL 1 HOUR as max_ts,
        count(*) as cnt
      FROM observations
      WHERE project_id = {projectId: String} AND trace_id IN ({traceIds: Array(String)})
    `,
    params: { projectId, traceIds },
    clickhouseConfigs: {
      request_timeout: env.LANGFUSE_CLICKHOUSE_DELETION_TIMEOUT_MS,
    },
    tags: { projectId },
  });

  const count = Number(preflight[0]?.cnt ?? 0);
  if (count === 0) {
    logger.info(
      `deleteObservationsByTraceIds: no rows found for project ${projectId}, skipping DELETE`,
    );
    return;
  }

  await commandClickhouse({
    query: `
      DELETE FROM observations
      WHERE project_id = {projectId: String}
      AND trace_id IN ({traceIds: Array(String)})
      AND start_time >= {minTs: String}::DateTime64(3)
      AND start_time <= {maxTs: String}::DateTime64(3)
    `,
    params: {
      projectId,
      traceIds,
      minTs: preflight[0].min_ts,
      maxTs: preflight[0].max_ts,
    },
    clickhouseConfigs: {
      request_timeout: env.LANGFUSE_CLICKHOUSE_DELETION_TIMEOUT_MS,
    },
    tags: { projectId },
  });
};

export const hasAnyObservation = async (projectId: string) => {
  const query = `
    SELECT 1
    FROM observations
    WHERE project_id = {projectId: String}
    LIMIT 1
  `;

  const rows = await queryClickhouse<{ 1: number }>({
    query,
    params: { projectId },
    tags: { projectId },
  });

  return rows.length > 0;
};

export const deleteObservationsByProjectId = async (projectId: string): Promise<boolean> => {
  const hasData = await hasAnyObservation(projectId);
  if (!hasData) {
    return false;
  }

  const query = `
    DELETE FROM observations
    WHERE project_id = {projectId: String};
  `;
  const tags = { projectId };

  await commandClickhouse({
    query,
    params: { projectId },
    clickhouseConfigs: {
      request_timeout: env.LANGFUSE_CLICKHOUSE_DELETION_TIMEOUT_MS,
    },
    tags,
  });

  return true;
};

export const hasAnyObservationOlderThan = async (projectId: string, beforeDate: Date) => {
  const query = `
    SELECT 1
    FROM observations
    WHERE project_id = {projectId: String}
    AND start_time < {cutoffDate: DateTime64(3)}
    LIMIT 1
  `;

  const rows = await queryClickhouse<{ 1: number }>({
    query,
    params: {
      projectId,
      cutoffDate: convertDateToClickhouseDateTime(beforeDate),
    },
    tags: { projectId },
  });

  return rows.length > 0;
};

export const deleteObservationsOlderThanDays = async (
  projectId: string,
  beforeDate: Date,
): Promise<boolean> => {
  const hasData = await hasAnyObservationOlderThan(projectId, beforeDate);
  if (!hasData) {
    return false;
  }

  const query = `
    DELETE FROM observations
    WHERE project_id = {projectId: String}
    AND start_time < {cutoffDate: DateTime64(3)};
  `;
  await commandClickhouse({
    query: query,
    params: {
      projectId,
      cutoffDate: convertDateToClickhouseDateTime(beforeDate),
    },
    clickhouseConfigs: {
      request_timeout: env.LANGFUSE_CLICKHOUSE_DELETION_TIMEOUT_MS,
    },
    tags: { projectId },
  });

  return true;
};
