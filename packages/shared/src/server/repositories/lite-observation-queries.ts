import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";
import type { FilterList } from "../queries/clickhouse-sql/clickhouse-filter";
import type { ObservationRecordReadType } from "./definitions";
import { liteBuildFilterWhere } from "./lite-query-filters";
import { safeJsonParse, toDateStr, toUsageRecord } from "./lite-query-values";
/**
 * Get observations for a trace, returned as ObservationRecordReadType[].
 */
export async function liteGetObservationsForTrace(
  projectId: string,
  traceId: string,
  includeIO = false,
): Promise<ObservationRecordReadType[]> {
  const db = getTelemetryDB();

  const ioColumns = includeIO
    ? "input, input_codec, input_raw_size, output, output_codec, output_raw_size, metadata,"
    : "";

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT id, trace_id, project_id, type, parent_observation_id,
               environment, start_time, end_time, name, level, status_message,
               version, ${ioColumns}
               model as provided_model_name,
               '' as internal_model_id,
               model_parameters,
               provided_usage_details, usage_details,
               provided_cost_details, cost_details,
               total_cost,
               '' as usage_pricing_tier_id,
               '' as usage_pricing_tier_name,
               completion_start_time,
               prompt_id, prompt_name, prompt_version,
               created_at, updated_at, event_ts
        FROM observations
        WHERE project_id = @projectId AND trace_id = @traceId AND is_deleted = 0
        ORDER BY start_time ASC
      `,
      params: { projectId, traceId },
    });

    return rows.map((row) => ({
      id: String(row.id),
      trace_id: row.trace_id ? String(row.trace_id) : null,
      project_id: String(row.project_id),
      type: String(row.type ?? "SPAN"),
      parent_observation_id: row.parent_observation_id ? String(row.parent_observation_id) : null,
      environment: String(row.environment ?? "default"),
      name: row.name ? String(row.name) : null,
      metadata: includeIO ? safeJsonParse<Record<string, string>>(row.metadata, {}) : {},
      level: row.level ? String(row.level) : null,
      status_message: row.status_message ? String(row.status_message) : null,
      version: row.version ? String(row.version) : null,
      input: includeIO && row.input != null ? String(row.input) : null,
      output: includeIO && row.output != null ? String(row.output) : null,
      provided_model_name: row.provided_model_name ? String(row.provided_model_name) : null,
      internal_model_id: null,
      model_parameters: row.model_parameters ? String(row.model_parameters) : null,
      total_cost: row.total_cost ? Number(row.total_cost) : null,
      usage_pricing_tier_id: null,
      usage_pricing_tier_name: null,
      prompt_id: row.prompt_id ? String(row.prompt_id) : null,
      prompt_name: row.prompt_name ? String(row.prompt_name) : null,
      prompt_version: row.prompt_version ? Number(row.prompt_version) : null,
      tool_definitions: undefined,
      tool_calls: undefined,
      tool_call_names: undefined,
      is_deleted: 0,
      start_time: toDateStr(row.start_time),
      end_time: row.end_time ? toDateStr(row.end_time) : null,
      completion_start_time: row.completion_start_time
        ? toDateStr(row.completion_start_time)
        : null,
      created_at: toDateStr(row.created_at),
      updated_at: toDateStr(row.updated_at),
      event_ts: toDateStr(row.event_ts),
      provided_usage_details: toUsageRecord(row.provided_usage_details),
      provided_cost_details: toUsageRecord(row.provided_cost_details),
      usage_details: toUsageRecord(row.usage_details),
      cost_details: toUsageRecord(row.cost_details),
    })) as ObservationRecordReadType[];
  } catch (error) {
    logger.error("[liteGetObservationsForTrace] Query failed", error);
    throw error;
  }
}

/**
 * Get observations for MULTIPLE traces in a single query (batch variant).
 * Returns a Map keyed by trace_id. Avoids N+1 queries when loading
 * observations for all traces in a session.
 */
export async function liteGetObservationsForTraces(
  projectId: string,
  traceIds: string[],
  includeIO = false,
): Promise<Map<string, ObservationRecordReadType[]>> {
  const result = new Map<string, ObservationRecordReadType[]>();
  if (traceIds.length === 0) return result;

  const db = getTelemetryDB();
  const ioColumns = includeIO
    ? "input, input_codec, input_raw_size, output, output_codec, output_raw_size, metadata,"
    : "";
  const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
  const params: Record<string, unknown> = { projectId };
  traceIds.forEach((id, i) => {
    params[`id${i}`] = id;
  });

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT id, trace_id, project_id, type, parent_observation_id,
               environment, start_time, end_time, name, level, status_message,
               version, ${ioColumns}
               model as provided_model_name,
               '' as internal_model_id,
               model_parameters,
               provided_usage_details, usage_details,
               provided_cost_details, cost_details,
               total_cost,
               '' as usage_pricing_tier_id,
               '' as usage_pricing_tier_name,
               completion_start_time,
               prompt_id, prompt_name, prompt_version,
               created_at, updated_at, event_ts
        FROM observations
        WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
        ORDER BY start_time ASC
      `,
      params,
    });

    for (const row of rows) {
      const record = {
        id: String(row.id),
        trace_id: row.trace_id ? String(row.trace_id) : null,
        project_id: String(row.project_id),
        type: String(row.type ?? "SPAN"),
        parent_observation_id: row.parent_observation_id ? String(row.parent_observation_id) : null,
        environment: String(row.environment ?? "default"),
        name: row.name ? String(row.name) : null,
        metadata: includeIO ? safeJsonParse<Record<string, string>>(row.metadata, {}) : {},
        level: row.level ? String(row.level) : null,
        status_message: row.status_message ? String(row.status_message) : null,
        version: row.version ? String(row.version) : null,
        input: includeIO && row.input != null ? String(row.input) : null,
        output: includeIO && row.output != null ? String(row.output) : null,
        provided_model_name: row.provided_model_name ? String(row.provided_model_name) : null,
        internal_model_id: null,
        model_parameters: row.model_parameters ? String(row.model_parameters) : null,
        total_cost: row.total_cost ? Number(row.total_cost) : null,
        usage_pricing_tier_id: null,
        usage_pricing_tier_name: null,
        prompt_id: row.prompt_id ? String(row.prompt_id) : null,
        prompt_name: row.prompt_name ? String(row.prompt_name) : null,
        prompt_version: row.prompt_version ? Number(row.prompt_version) : null,
        tool_definitions: undefined,
        tool_calls: undefined,
        tool_call_names: undefined,
        is_deleted: 0,
        start_time: toDateStr(row.start_time),
        end_time: row.end_time ? toDateStr(row.end_time) : null,
        completion_start_time: row.completion_start_time
          ? toDateStr(row.completion_start_time)
          : null,
        created_at: toDateStr(row.created_at),
        updated_at: toDateStr(row.updated_at),
        event_ts: toDateStr(row.event_ts),
        provided_usage_details: toUsageRecord(row.provided_usage_details),
        provided_cost_details: toUsageRecord(row.provided_cost_details),
        usage_details: toUsageRecord(row.usage_details),
        cost_details: toUsageRecord(row.cost_details),
      } as ObservationRecordReadType;

      const tid = record.trace_id;
      if (tid) {
        const list = result.get(tid) ?? [];
        list.push(record);
        result.set(tid, list);
      }
    }
  } catch (error) {
    logger.error("[liteGetObservationsForTraces] Batch query failed", error);
    throw error;
  }
  return result;
}
/**
 * Get a single observation by ID.
 */
export async function liteGetObservationById(
  projectId: string,
  observationId: string,
): Promise<ObservationRecordReadType | undefined> {
  const db = getTelemetryDB();

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `SELECT * FROM observations WHERE project_id = @projectId AND id = @observationId AND is_deleted = 0 LIMIT 1`,
      params: { projectId, observationId },
    });

    if (rows.length === 0) return undefined;

    const row = rows[0];
    return {
      id: String(row.id),
      trace_id: row.trace_id ? String(row.trace_id) : null,
      project_id: String(row.project_id),
      type: String(row.type ?? "SPAN"),
      parent_observation_id: row.parent_observation_id ? String(row.parent_observation_id) : null,
      environment: String(row.environment ?? "default"),
      name: row.name ? String(row.name) : null,
      metadata: safeJsonParse<Record<string, string>>(row.metadata, {}),
      level: row.level ? String(row.level) : null,
      status_message: row.status_message ? String(row.status_message) : null,
      version: row.version ? String(row.version) : null,
      input: row.input != null ? String(row.input) : null,
      output: row.output != null ? String(row.output) : null,
      provided_model_name: row.provided_model_name ? String(row.provided_model_name) : null,
      internal_model_id: null,
      model_parameters: row.model_parameters ? String(row.model_parameters) : null,
      total_cost: row.total_cost ? Number(row.total_cost) : null,
      usage_pricing_tier_id: null,
      usage_pricing_tier_name: null,
      prompt_id: row.prompt_id ? String(row.prompt_id) : null,
      prompt_name: row.prompt_name ? String(row.prompt_name) : null,
      prompt_version: row.prompt_version ? Number(row.prompt_version) : null,
      tool_definitions: undefined,
      tool_calls: undefined,
      tool_call_names: undefined,
      is_deleted: 0,
      start_time: toDateStr(row.start_time),
      end_time: row.end_time ? toDateStr(row.end_time) : null,
      completion_start_time: row.completion_start_time
        ? toDateStr(row.completion_start_time)
        : null,
      created_at: toDateStr(row.created_at),
      updated_at: toDateStr(row.updated_at),
      event_ts: toDateStr(row.event_ts),
      provided_usage_details: toUsageRecord(row.provided_usage_details),
      provided_cost_details: toUsageRecord(row.provided_cost_details),
      usage_details: toUsageRecord(row.usage_details),
      cost_details: toUsageRecord(row.cost_details),
    } as ObservationRecordReadType;
  } catch (error) {
    logger.error("[liteGetObservationById] Query failed", error);
    throw error;
  }
}

/**
 * Get observations list with pagination.
 */
export async function liteGetObservationsTable(
  projectId: string,
  limit = 50,
  page = 0,
  filter?: FilterList,
  includeIO = true,
): Promise<ObservationRecordReadType[]> {
  const db = getTelemetryDB();
  const offset = limit * page;
  const { clause, params: filterParams } = liteBuildFilterWhere(filter, "observations");

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT id, trace_id, project_id, type, parent_observation_id, environment,
          name, level, status_message, version, model, model_parameters, total_cost,
          prompt_id, prompt_name, prompt_version, start_time, end_time, completion_start_time,
          created_at, updated_at, event_ts, provided_usage_details, provided_cost_details,
          usage_details, cost_details ${includeIO ? ", input, input_codec, input_raw_size, output, output_codec, output_raw_size, metadata" : ""}
        FROM observations
        WHERE project_id = @projectId AND is_deleted = 0
        ${clause ? `AND ${clause}` : ""}
        ORDER BY start_time DESC
        LIMIT @limit OFFSET @offset
      `,
      params: { projectId, limit, offset, ...filterParams },
    });

    return rows.map((row) => ({
      id: String(row.id),
      trace_id: row.trace_id ? String(row.trace_id) : null,
      project_id: String(row.project_id),
      type: String(row.type ?? "SPAN"),
      parent_observation_id: row.parent_observation_id ? String(row.parent_observation_id) : null,
      environment: String(row.environment ?? "default"),
      name: row.name ? String(row.name) : null,
      metadata: safeJsonParse<Record<string, string>>(row.metadata, {}),
      level: row.level ? String(row.level) : null,
      status_message: row.status_message ? String(row.status_message) : null,
      version: row.version ? String(row.version) : null,
      input: row.input != null ? String(row.input) : null,
      output: row.output != null ? String(row.output) : null,
      provided_model_name: row.model ? String(row.model) : null,
      internal_model_id: null,
      model_parameters: row.model_parameters ? String(row.model_parameters) : null,
      total_cost: row.total_cost ? Number(row.total_cost) : null,
      usage_pricing_tier_id: null,
      usage_pricing_tier_name: null,
      prompt_id: row.prompt_id ? String(row.prompt_id) : null,
      prompt_name: row.prompt_name ? String(row.prompt_name) : null,
      prompt_version: row.prompt_version ? Number(row.prompt_version) : null,
      tool_definitions: undefined,
      tool_calls: undefined,
      tool_call_names: undefined,
      is_deleted: 0,
      start_time: toDateStr(row.start_time),
      end_time: row.end_time ? toDateStr(row.end_time) : null,
      completion_start_time: row.completion_start_time
        ? toDateStr(row.completion_start_time)
        : null,
      created_at: toDateStr(row.created_at),
      updated_at: toDateStr(row.updated_at),
      event_ts: toDateStr(row.event_ts),
      provided_usage_details: toUsageRecord(row.provided_usage_details),
      provided_cost_details: toUsageRecord(row.provided_cost_details),
      usage_details: toUsageRecord(row.usage_details),
      cost_details: toUsageRecord(row.cost_details),
    })) as ObservationRecordReadType[];
  } catch (error) {
    logger.error("[liteGetObservationsTable] Query failed", error);
    throw error;
  }
}

/**
 * Get observations count with optional filtering (for public API pagination).
 */
export async function liteGetObservationsTableCount(
  projectId: string,
  filter?: FilterList,
): Promise<number> {
  const db = getTelemetryDB();
  const { clause, params: filterParams } = liteBuildFilterWhere(filter, "observations");

  try {
    const rows = await db.query<{ count: number }>({
      query: `
        SELECT COUNT(*) as count FROM observations
        WHERE project_id = @projectId AND is_deleted = 0
        ${clause ? `AND ${clause}` : ""}
      `,
      params: { projectId, ...filterParams },
    });
    return rows.length > 0 ? Number(rows[0].count) : 0;
  } catch (error) {
    logger.error("[liteGetObservationsTableCount] Query failed", error);
    return 0;
  }
}
