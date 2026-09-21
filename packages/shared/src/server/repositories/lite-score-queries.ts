import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";
import type { FilterList } from "../queries/clickhouse-sql/clickhouse-filter";
import type { ScoreRecordReadType } from "./definitions";
import { liteBuildFilterWhere } from "./lite-query-filters";
import { safeJsonParse, toDateStr } from "./lite-query-values";
/**
 * Get scores for a set of traces, returned as ScoreRecordReadType[].
 */
export async function liteGetScoresForTraces(
  projectId: string,
  traceIds: string[],
): Promise<ScoreRecordReadType[]> {
  if (traceIds.length === 0) return [];
  const db = getTelemetryDB();

  try {
    const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
    const params: Record<string, unknown> = { projectId };
    traceIds.forEach((id, i) => {
      params[`id${i}`] = id;
    });

    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT * FROM scores
        WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
        ORDER BY timestamp DESC
      `,
      params,
    });

    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      trace_id: row.trace_id ? String(row.trace_id) : null,
      session_id: null,
      observation_id: row.observation_id ? String(row.observation_id) : null,
      dataset_run_id: null,
      environment: String(row.environment ?? "default"),
      name: String(row.name),
      value: row.value !== null ? Number(row.value) : 0,
      source: String(row.source ?? "API"),
      comment: row.comment ? String(row.comment) : null,
      metadata: safeJsonParse<Record<string, string>>(row.metadata, {}),
      author_user_id: row.author_user_id ? String(row.author_user_id) : null,
      config_id: row.config_id ? String(row.config_id) : null,
      data_type: String(row.data_type ?? "NUMERIC"),
      string_value: row.string_value ? String(row.string_value) : null,
      long_string_value: row.string_value ? String(row.string_value) : "",
      queue_id: row.queue_id ? String(row.queue_id) : null,
      execution_trace_id: null,
      ingestion_api_key: "",
      ingestion_sdk_name: "",
      ingestion_sdk_version: "",
      is_deleted: 0,
      timestamp: toDateStr(row.timestamp),
      created_at: toDateStr(row.created_at),
      updated_at: toDateStr(row.updated_at),
      event_ts: toDateStr(row.event_ts),
    })) as ScoreRecordReadType[];
  } catch (error) {
    logger.error("[liteGetScoresForTraces] Query failed", error);
    return [];
  }
}
/**
 * Get a single score by ID.
 */
export async function liteGetScoreById(
  projectId: string,
  scoreId: string,
): Promise<ScoreRecordReadType | undefined> {
  const db = getTelemetryDB();

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `SELECT * FROM scores WHERE project_id = @projectId AND id = @scoreId AND is_deleted = 0 LIMIT 1`,
      params: { projectId, scoreId },
    });

    if (rows.length === 0) return undefined;

    const row = rows[0];
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      trace_id: row.trace_id ? String(row.trace_id) : null,
      session_id: null,
      observation_id: row.observation_id ? String(row.observation_id) : null,
      environment: String(row.environment ?? "default"),
      name: String(row.name),
      value: row.value != null ? Number(row.value) : null,
      string_value: row.string_value ? String(row.string_value) : null,
      data_type: String(row.data_type ?? "NUMERIC"),
      source: String(row.source ?? "API"),
      comment: row.comment ? String(row.comment) : null,
      metadata: safeJsonParse<Record<string, string>>(row.metadata, {}),
      author_user_id: row.author_user_id ? String(row.author_user_id) : null,
      config_id: row.config_id ? String(row.config_id) : null,
      queue_id: row.queue_id ? String(row.queue_id) : null,
      execution_trace_id: row.execution_trace_id ? String(row.execution_trace_id) : null,
      is_deleted: 0,
      timestamp: toDateStr(row.timestamp),
      created_at: toDateStr(row.created_at),
      updated_at: toDateStr(row.updated_at),
      event_ts: toDateStr(row.event_ts),
    } as ScoreRecordReadType;
  } catch (error) {
    logger.error("[liteGetScoreById] Query failed", error);
    return undefined;
  }
}

/**
 * Get scores list with pagination.
 */
export async function liteGetScoresTable(
  projectId: string,
  limit = 50,
  page = 0,
  filter?: FilterList,
): Promise<ScoreRecordReadType[]> {
  const db = getTelemetryDB();
  const offset = limit * page;
  const { clause, params: filterParams } = liteBuildFilterWhere(filter, "scores");

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT * FROM scores
        WHERE project_id = @projectId AND is_deleted = 0
        ${clause ? `AND ${clause}` : ""}
        ORDER BY timestamp DESC
        LIMIT @limit OFFSET @offset
      `,
      params: { projectId, limit, offset, ...filterParams },
    });

    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      trace_id: row.trace_id ? String(row.trace_id) : null,
      session_id: null,
      observation_id: row.observation_id ? String(row.observation_id) : null,
      environment: String(row.environment ?? "default"),
      name: String(row.name),
      value: row.value != null ? Number(row.value) : null,
      string_value: row.string_value ? String(row.string_value) : null,
      data_type: String(row.data_type ?? "NUMERIC"),
      source: String(row.source ?? "API"),
      comment: row.comment ? String(row.comment) : null,
      metadata: safeJsonParse<Record<string, string>>(row.metadata, {}),
      author_user_id: row.author_user_id ? String(row.author_user_id) : null,
      config_id: row.config_id ? String(row.config_id) : null,
      queue_id: row.queue_id ? String(row.queue_id) : null,
      execution_trace_id: row.execution_trace_id ? String(row.execution_trace_id) : null,
      is_deleted: 0,
      timestamp: toDateStr(row.timestamp),
      created_at: toDateStr(row.created_at),
      updated_at: toDateStr(row.updated_at),
      event_ts: toDateStr(row.event_ts),
    })) as ScoreRecordReadType[];
  } catch (error) {
    logger.error("[liteGetScoresTable] Query failed", error);
    return [];
  }
}
/**
 * Get scores count with optional filtering (for public API pagination).
 */
export async function liteGetScoresTableCount(
  projectId: string,
  filter?: FilterList,
): Promise<number> {
  const db = getTelemetryDB();
  const { clause, params: filterParams } = liteBuildFilterWhere(filter, "scores");

  try {
    const rows = await db.query<{ count: number }>({
      query: `
        SELECT COUNT(*) as count FROM scores
        WHERE project_id = @projectId AND is_deleted = 0
        ${clause ? `AND ${clause}` : ""}
      `,
      params: { projectId, ...filterParams },
    });
    return rows.length > 0 ? Number(rows[0].count) : 0;
  } catch (error) {
    logger.error("[liteGetScoresTableCount] Query failed", error);
    return 0;
  }
}
