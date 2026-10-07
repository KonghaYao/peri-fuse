import { env } from "../../env";
import { PayloadTooLargeError } from "../../errors";
import { isLiteMode } from "../adapters";
import {
  convertDateToClickhouseDateTime,
  type PreferredClickhouseService,
} from "../clickhouse/client";
import { recordDistribution } from "../instrumentation";
import { shouldSkipObservationsFinal } from "../queries/clickhouse-sql/query-options";
import { queryClickhouse, upsertClickhouse } from "./clickhouse";
import { OBSERVATIONS_TO_TRACE_INTERVAL, TRACE_TO_OBSERVATIONS_INTERVAL } from "./constants";
import type { ObservationRecordReadType } from "./definitions";
import { liteGetObservationsForTrace } from "./lite-queries";
import { convertObservation } from "./observations_converters";

/**
 * Checks if observation exists in clickhouse.
 *
 * @param {string} projectId - Project ID for the observation
 * @param {string} id - ID of the observation
 * @param {Date} startTime - Timestamp for time-based filtering, uses event payload or job timestamp
 * @returns {Promise<boolean>} - True if observation exists
 *
 * Notes:
 * • Filters with two days lookback window subject to startTime
 * • Used for validating observation references before eval job creation
 */
export const checkObservationExists = async (
  projectId: string,
  id: string,
  startTime: Date | undefined,
): Promise<boolean> => {
  const query = `
    SELECT id, project_id
    FROM observations o
    WHERE project_id = {projectId: String}
    AND id = {id: String}
    ${startTime ? `AND start_time >= {startTime: DateTime64(3)} - ${OBSERVATIONS_TO_TRACE_INTERVAL}` : ""}
    ORDER BY event_ts DESC
    LIMIT 1 BY id, project_id
  `;

  const rows = await queryClickhouse<{ id: string; project_id: string }>({
    query,
    params: {
      id,
      projectId,
      ...(startTime ? { startTime: convertDateToClickhouseDateTime(startTime) } : {}),
    },
    tags: { projectId },
  });

  return rows.length > 0;
};

/**
 * Accepts a trace in a Clickhouse-ready format.
 * id, project_id, and timestamp must always be provided.
 */
export const upsertObservation = async (observation: Partial<ObservationRecordReadType>) => {
  if (!["id", "project_id", "start_time", "type"].every((key) => key in observation)) {
    throw new Error("Identifier fields must be provided to upsert Observation.");
  }
  await upsertClickhouse({
    table: "observations",
    records: [observation as ObservationRecordReadType],
    eventBodyMapper: convertObservation,
    tags: { projectId: observation.project_id ?? "" },
  });
};

export type GetObservationsForTraceOpts<IncludeIO extends boolean> = {
  traceId: string;
  projectId: string;
  timestamp?: Date;
  includeIO?: IncludeIO;
  preferredClickhouseService?: PreferredClickhouseService;
};

export const getObservationsForTrace = async <IncludeIO extends boolean>(
  opts: GetObservationsForTraceOpts<IncludeIO>,
) => {
  const { traceId, projectId, timestamp, includeIO = false, preferredClickhouseService } = opts;

  if (isLiteMode()) {
    const records = await liteGetObservationsForTrace(projectId, traceId, includeIO);
    return records.map((r) => convertObservation({ ...r, metadata: r.metadata ?? {} }));
  }

  // OTel projects use immutable spans - no need for deduplication
  const skipDedup = await shouldSkipObservationsFinal(projectId);

  const query = `
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
    level,
    status_message,
    version,
    ${includeIO === true ? "input, output, metadata," : ""}
    provided_model_name,
    internal_model_id,
    model_parameters,
    provided_usage_details,
    usage_details,
    provided_cost_details,
    cost_details,
    total_cost,
    usage_pricing_tier_id,
    usage_pricing_tier_name,
    completion_start_time,
    prompt_id,
    prompt_name,
    prompt_version,
    ${includeIO === true ? "tool_definitions, tool_calls, tool_call_names," : ""}
    created_at,
    updated_at,
    event_ts
  FROM observations
  WHERE trace_id = {traceId: String}
  AND project_id = {projectId: String}
   ${timestamp ? `AND start_time >= {traceTimestamp: DateTime64(3)} - ${TRACE_TO_OBSERVATIONS_INTERVAL}` : ""}
  ${skipDedup ? "" : "ORDER BY event_ts DESC"}
  ${skipDedup ? "" : "LIMIT 1 BY id, project_id"}`;
  const records = await queryClickhouse<ObservationRecordReadType>({
    query,
    params: {
      traceId,
      projectId,
      ...(timestamp ? { traceTimestamp: convertDateToClickhouseDateTime(timestamp) } : {}),
    },
    tags: { projectId },
    preferredClickhouseService,
  });

  // Large number of observations in trace with large input / output / metadata will lead to
  // high CPU and memory consumption in the convertObservation step, where parsing occurs
  // Thus, limit the size of the payload to 5MB, follows NextJS response size limitation:
  // https://nextjs.org/docs/messages/api-routes-response-size-limit
  // See also LFE-4882 for more details
  let payloadSize = 0;

  for (const observation of records) {
    for (const key of ["input", "output"] as const) {
      const value = observation[key];

      if (value && typeof value === "string") {
        payloadSize += value.length;
      }
    }

    const metadataValues = Object.values(observation.metadata ?? {});

    metadataValues.forEach((value) => {
      if (value && typeof value === "string") {
        payloadSize += value.length;
      }
    });

    if (payloadSize >= env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES) {
      const errorMessage = `Observations in trace are too large: ${(payloadSize / 1e6).toFixed(2)}MB exceeds limit of ${(env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES / 1e6).toFixed(2)}MB`;

      throw new PayloadTooLargeError(errorMessage);
    }
  }

  return records.map((r) => {
    const observation = convertObservation({
      ...r,
      metadata: r.metadata ?? {},
    });
    recordDistribution("langfuse.query_by_id_age", Date.now() - observation.startTime.getTime(), {
      table: "observations",
    });
    return observation;
  });
};

export const getObservationForTraceIdByName = async ({
  traceId,
  projectId,
  name,
  timestamp,
  fetchWithInputOutput = false,
}: {
  traceId: string;
  projectId: string;
  name: string;
  timestamp?: Date;
  fetchWithInputOutput?: boolean;
}) => {
  const query = `
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
    ${fetchWithInputOutput ? "input, output," : ""}
    provided_model_name,
    internal_model_id,
    model_parameters,
    provided_usage_details,
    usage_details,
    provided_cost_details,
    cost_details,
    total_cost,
    usage_pricing_tier_id,
    usage_pricing_tier_name,
    completion_start_time,
    prompt_id,
    prompt_name,
    prompt_version,
    tool_definitions,
    tool_calls,
    tool_call_names,
    created_at,
    updated_at,
    event_ts
  FROM observations
  WHERE trace_id = {traceId: String}
  AND project_id = {projectId: String}
  AND name = {name: String}
   ${timestamp ? `AND start_time >= {traceTimestamp: DateTime64(3)} - ${TRACE_TO_OBSERVATIONS_INTERVAL}` : ""}
  ORDER BY event_ts DESC
  LIMIT 1 BY id, project_id`;
  const records = await queryClickhouse<ObservationRecordReadType>({
    query,
    params: {
      traceId,
      projectId,
      name,
      ...(timestamp ? { traceTimestamp: convertDateToClickhouseDateTime(timestamp) } : {}),
    },
    tags: { projectId },
  });

  return records.map((record) => convertObservation(record));
};
