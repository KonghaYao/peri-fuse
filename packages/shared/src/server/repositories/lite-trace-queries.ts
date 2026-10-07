import type { MetadataDomain, TraceDomain } from "../../domain";
import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";
import type { FilterList } from "../queries/clickhouse-sql/clickhouse-filter";
import { liteBuildFilterWhere } from "./lite-query-filters";
import { safeJsonParse, toBool } from "./lite-query-values";
export interface LiteTracesTableOpts {
  projectId: string;
  limit?: number;
  page?: number;
  searchQuery?: string;
  orderBy?: { column: string; order: "ASC" | "DESC" } | null;
  filter?: FilterList;
  includeIO?: boolean;
}

export interface LiteTraceRow {
  id: string;
  projectId: string;
  timestamp: Date;
  tags: string[];
  bookmarked: boolean;
  name: string | null;
  release: string | null;
  version: string | null;
  userId: string | null;
  environment: string | null;
  sessionId: string | null;
  public: boolean;
  input: string | null;
  output: string | null;
  metadata: MetadataDomain;
}

/**
 * Get traces for the UI table listing.
 */
export async function liteGetTracesTable(opts: LiteTracesTableOpts): Promise<LiteTraceRow[]> {
  const db = getTelemetryDB();
  const { projectId, limit = 50, page = 0, searchQuery, orderBy, filter } = opts;

  let whereClause = "WHERE project_id = @projectId AND is_deleted = 0";
  const params: Record<string, unknown> = { projectId };

  if (searchQuery) {
    whereClause += " AND (id LIKE @search OR name LIKE @search)";
    params.search = `%${searchQuery}%`;
  }

  // Apply FilterList conditions
  const { clause: filterClause, params: filterParams } = liteBuildFilterWhere(filter, "traces");
  if (filterClause) {
    whereClause += ` AND ${filterClause}`;
    Object.assign(params, filterParams);
  }

  // Map orderBy column to SQLite column
  let orderClause = "ORDER BY timestamp DESC";
  if (orderBy?.column) {
    const colMap: Record<string, string> = {
      timestamp: "timestamp",
      name: "name",
      createdAt: "created_at",
      userId: "user_id",
      sessionId: "session_id",
    };
    const col = colMap[orderBy.column] ?? "timestamp";
    const dir = orderBy.order === "ASC" ? "ASC" : "DESC";
    orderClause = `ORDER BY ${col} ${dir}`;
  }

  const offset = limit * page;
  params.limit = limit;
  params.offset = offset;

  const query = `
    SELECT id, project_id, timestamp, name, user_id, release, version,
           public, bookmarked, tags, session_id, environment
           ${opts.includeIO ? ", input, input_codec, input_raw_size, output, output_codec, output_raw_size, metadata" : ""}
    FROM traces
    ${whereClause}
    ${orderClause}
    LIMIT @limit OFFSET @offset
  `;

  try {
    const rows = await db.query<Record<string, unknown>>({ query, params });
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      timestamp: new Date(`${String(row.timestamp).replace(" ", "T")}Z`),
      tags: safeJsonParse<string[]>(row.tags, []),
      bookmarked: toBool(row.bookmarked),
      name: row.name ? String(row.name) : null,
      release: row.release ? String(row.release) : null,
      version: row.version ? String(row.version) : null,
      userId: row.user_id ? String(row.user_id) : null,
      environment: row.environment ? String(row.environment) : null,
      sessionId: row.session_id ? String(row.session_id) : null,
      public: toBool(row.public),
      input: row.input == null ? null : String(row.input),
      output: row.output == null ? null : String(row.output),
      metadata: safeJsonParse<MetadataDomain>(row.metadata, {} as MetadataDomain),
    }));
  } catch (error) {
    logger.error("[liteGetTracesTable] Query failed", error);
    throw error;
  }
}

/**
 * Get total trace count for pagination.
 */
export async function liteGetTracesTableCount(
  projectId: string,
  searchQuery?: string,
  filter?: FilterList,
): Promise<number> {
  const db = getTelemetryDB();

  let whereClause = "WHERE project_id = @projectId AND is_deleted = 0";
  const params: Record<string, unknown> = { projectId };

  if (searchQuery) {
    whereClause += " AND (id LIKE @search OR name LIKE @search)";
    params.search = `%${searchQuery}%`;
  }

  const { clause: filterClause, params: filterParams } = liteBuildFilterWhere(filter, "traces");
  if (filterClause) {
    whereClause += ` AND ${filterClause}`;
    Object.assign(params, filterParams);
  }

  try {
    const rows = await db.query<{ count: number }>({
      query: `SELECT COUNT(*) as count FROM traces ${whereClause}`,
      params,
    });
    return rows.length > 0 ? Number(rows[0].count) : 0;
  } catch (error) {
    logger.error("[liteGetTracesTableCount] Query failed", error);
    return 0;
  }
}

/**
 * Get a single trace by ID, returned as TraceDomain.
 */
export async function liteGetTraceById(
  projectId: string,
  traceId: string,
  excludeInputOutput = false,
  excludeMetadata = false,
): Promise<TraceDomain | undefined> {
  const db = getTelemetryDB();

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `SELECT id, project_id, name, timestamp, environment, tags, bookmarked,
        release, version, user_id, session_id, public, created_at, updated_at,
        ${excludeInputOutput ? "NULL AS input, NULL AS output" : "input, input_codec, input_raw_size, output, output_codec, output_raw_size"},
        ${excludeMetadata ? "NULL AS metadata" : "metadata"}
        FROM traces WHERE project_id = @projectId AND id = @traceId AND is_deleted = 0 LIMIT 1`,
      params: { projectId, traceId },
    });

    if (rows.length === 0) return undefined;

    const row = rows[0];
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      name: row.name ? String(row.name) : null,
      timestamp: new Date(`${String(row.timestamp).replace(" ", "T")}Z`),
      environment: row.environment ? String(row.environment) : "default",
      tags: safeJsonParse<string[]>(row.tags, []),
      bookmarked: toBool(row.bookmarked),
      release: row.release ? String(row.release) : null,
      version: row.version ? String(row.version) : null,
      userId: row.user_id ? String(row.user_id) : null,
      sessionId: row.session_id ? String(row.session_id) : null,
      public: toBool(row.public),
      input: row.input != null ? String(row.input) : null,
      output: row.output != null ? String(row.output) : null,
      metadata: safeJsonParse<MetadataDomain>(row.metadata, {} as MetadataDomain),
      createdAt: new Date(`${String(row.created_at).replace(" ", "T")}Z`),
      updatedAt: new Date(`${String(row.updated_at).replace(" ", "T")}Z`),
    };
  } catch (error) {
    logger.error("[liteGetTraceById] Query failed", error);
    throw error;
  }
}
/**
 * Get trace identifiers for a session.
 */
export async function liteGetTracesIdentifierForSession(
  projectId: string,
  sessionId: string,
): Promise<
  Array<{
    id: string;
    timestamp: Date;
    name: string | null;
    userId: string | null;
  }>
> {
  const db = getTelemetryDB();

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT id, timestamp, name, user_id
        FROM traces
        WHERE project_id = @projectId AND session_id = @sessionId AND is_deleted = 0
        ORDER BY timestamp ASC
      `,
      params: { projectId, sessionId },
    });

    return rows.map((row) => ({
      id: String(row.id),
      timestamp: new Date(`${String(row.timestamp).replace(" ", "T")}Z`),
      name: row.name ? String(row.name) : null,
      userId: row.user_id ? String(row.user_id) : null,
    }));
  } catch (error) {
    logger.error("[liteGetTracesIdentifierForSession] Query failed", error);
    return [];
  }
}

/**
 * Check if any traces exist for a project.
 */
export async function liteHasAnyTrace(projectId: string): Promise<boolean> {
  const db = getTelemetryDB();

  try {
    const rows = await db.query<{ count: number }>({
      query: `SELECT COUNT(*) as count FROM traces WHERE project_id = @projectId AND is_deleted = 0 LIMIT 1`,
      params: { projectId },
    });
    return rows.length > 0 && Number(rows[0].count) > 0;
  } catch {
    return false;
  }
}
/**
 * Get trace attribution info (userId/tags/environment/sessionId) for a set of
 * trace IDs. Used to enrich lite-mode public API score responses.
 */
export async function liteGetTraceInfoByIds(
  projectId: string,
  traceIds: string[],
): Promise<
  Map<
    string,
    {
      userId: string | null;
      tags: string[];
      environment: string | null;
      sessionId: string | null;
    }
  >
> {
  const result = new Map<
    string,
    {
      userId: string | null;
      tags: string[];
      environment: string | null;
      sessionId: string | null;
    }
  >();
  if (traceIds.length === 0) return result;
  const db = getTelemetryDB();

  try {
    const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
    const params: Record<string, unknown> = { projectId };
    traceIds.forEach((id, i) => {
      params[`id${i}`] = id;
    });

    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT id, user_id, tags, environment, session_id
        FROM traces
        WHERE project_id = @projectId AND id IN (${placeholders}) AND is_deleted = 0
      `,
      params,
    });

    for (const row of rows) {
      result.set(String(row.id), {
        userId: row.user_id ? String(row.user_id) : null,
        tags: safeJsonParse<string[]>(row.tags, []),
        environment: row.environment ? String(row.environment) : null,
        sessionId: row.session_id ? String(row.session_id) : null,
      });
    }
  } catch (error) {
    logger.error("[liteGetTraceInfoByIds] Query failed", error);
  }
  return result;
}
/**
 * Get sessions list with pagination.
 */
export async function liteGetSessionsTable(
  projectId: string,
  limit = 50,
  page = 0,
): Promise<Array<{ id: string; projectId: string; createdAt: Date }>> {
  const db = getTelemetryDB();
  const offset = limit * page;

  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT DISTINCT session_id as id, project_id, MIN(created_at) as created_at
        FROM traces
        WHERE project_id = @projectId AND session_id IS NOT NULL AND is_deleted = 0
        GROUP BY session_id
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `,
      params: { projectId, limit, offset },
    });

    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      createdAt: new Date(`${String(row.created_at).replace(" ", "T")}Z`),
    }));
  } catch (error) {
    logger.error("[liteGetSessionsTable] Query failed", error);
    return [];
  }
}
