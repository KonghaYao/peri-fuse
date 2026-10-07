import type { ObservationType } from "../../domain";
import { env } from "../../env";
import { InternalServerError, LangfuseNotFoundError } from "../../errors";
import { isLiteMode } from "../adapters";
import {
  convertDateToClickhouseDateTime,
  type PreferredClickhouseService,
} from "../clickhouse/client";
import { recordDistribution } from "../instrumentation";
import { logger } from "../logger";
import { DEFAULT_RENDERING_PROPS, type RenderingProps } from "../utils/rendering";
import { queryClickhouse } from "./clickhouse";
import type { ObservationRecordReadType } from "./definitions";
import { liteGetObservationById } from "./lite-queries";
import { convertObservation } from "./observations_converters";

/**
 * Retrieves an observation by its ID from the legacy `observations` table.
 *
 * Prefer the routing wrapper `getObservationById` (in repositories/events.ts)
 * for application reads: it dispatches between this legacy reader and the events
 * table based on the V4 migration flags. Call this directly only when you
 * specifically need the legacy table (e.g. backfills, migration tooling).
 */
export const getObservationByIdFromObservationsTable = async ({
  id,
  projectId,
  fetchWithInputOutput = false,
  startTime,
  type,
  traceId,
  renderingProps = DEFAULT_RENDERING_PROPS,
  preferredClickhouseService,
}: {
  id: string;
  projectId: string;
  fetchWithInputOutput?: boolean;
  startTime?: Date;
  type?: ObservationType;
  traceId?: string;
  renderingProps?: RenderingProps;
  preferredClickhouseService?: PreferredClickhouseService;
}) => {
  // Lite mode: use SQLite query
  if (isLiteMode()) {
    const record = await liteGetObservationById(projectId, id);
    if (!record) {
      throw new LangfuseNotFoundError(`Observation with id ${id} not found`);
    }
    return convertObservation({ ...record, metadata: record.metadata ?? {} }, renderingProps);
  }

  const records = await getObservationByIdInternal({
    id,
    projectId,
    fetchWithInputOutput,
    startTime,
    type,
    traceId,
    renderingProps,
    preferredClickhouseService,
  });
  const mapped = records.map((record) => convertObservation(record, renderingProps));

  mapped.forEach((observation) => {
    recordDistribution("langfuse.query_by_id_age", Date.now() - observation.startTime.getTime(), {
      table: "observations",
    });
  });
  if (mapped.length === 0) {
    throw new LangfuseNotFoundError(`Observation with id ${id} not found`);
  }

  if (mapped.length > 1) {
    logger.error(`Multiple observations found for id ${id} and project ${projectId}`);
    throw new InternalServerError(
      `Multiple observations found for id ${id} and project ${projectId}`,
    );
  }
  return mapped.shift();
};

export const getObservationsById = async (
  ids: string[],
  projectId: string,
  fetchWithInputOutput = false,
) => {
  const query = `
  SELECT
    id,
    trace_id,
    project_id,
    type,
    parent_observation_id,
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
  WHERE id IN ({ids: Array(String)})
  AND project_id = {projectId: String}
  ORDER BY event_ts desc
  LIMIT 1 by id, project_id`;
  const records = await queryClickhouse<ObservationRecordReadType>({
    query,
    params: { ids, projectId },
  });
  return records.map((record) => convertObservation(record));
};

export const getObservationByIdInternal = async ({
  id,
  projectId,
  fetchWithInputOutput = false,
  startTime,
  type,
  traceId,
  renderingProps = DEFAULT_RENDERING_PROPS,
  preferredClickhouseService,
}: {
  id: string;
  projectId: string;
  fetchWithInputOutput?: boolean;
  startTime?: Date;
  type?: ObservationType;
  traceId?: string;
  renderingProps?: RenderingProps;
  preferredClickhouseService?: PreferredClickhouseService;
}) => {
  const query = `
  SELECT
    id,
    trace_id,
    project_id,
    environment,
    type,
    parent_observation_id,
    start_time,
    end_time,
    name,
    metadata,
    level,
    status_message,
    version,
    ${fetchWithInputOutput ? (renderingProps.truncated ? `leftUTF8(input, ${env.LANGFUSE_SERVER_SIDE_IO_CHAR_LIMIT}) as input, leftUTF8(output, ${env.LANGFUSE_SERVER_SIDE_IO_CHAR_LIMIT}) as output,` : "input, output,") : ""}
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
  WHERE id = {id: String}
  AND project_id = {projectId: String}
  ${startTime ? `AND toDate(start_time) = toDate({startTime: DateTime64(3)})` : ""}
  ${type ? `AND type = {type: String}` : ""}
  ${traceId ? `AND trace_id = {traceId: String}` : ""}
  ORDER BY event_ts desc
  LIMIT 1 by id, project_id`;
  return await queryClickhouse<ObservationRecordReadType>({
    query,
    params: {
      id,
      projectId,
      ...(startTime ? { startTime: convertDateToClickhouseDateTime(startTime) } : {}),
      ...(traceId ? { traceId } : {}),
    },
    tags: { projectId },
    preferredClickhouseService,
  });
};
