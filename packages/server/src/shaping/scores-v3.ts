/**
 * v3 scores filter building + API shaping (GET /api/public/v3/scores).
 *
 * v3 semantics (Langfuse 4.x):
 * - Keyset cursor pagination: ORDER BY timestamp DESC, id DESC, with the
 *   cursor payload {v:1, lastTimestamp, lastId} base64url-encoded. The query
 *   fetches limit+1 rows to detect hasMore; the final page omits the cursor.
 * - 17 filter params (comma-separated list semantics), with cross-field
 *   validation done in the route layer.
 * - Field groups: details (comment/configId/metadata), subject
 *   (kind + entity id via trace/observation/session), annotation
 *   (authorUserId/queueId). Core fields are always returned.
 *
 * Lite mode: filters compile to SQLite SQL via liteBuildFilterWhere; rows are
 * converted through the shared domain converter and shaped with
 * scoreDomainToV3 (same pipeline as the upstream ClickHouse implementation).
 */
import {
  ScoreDataTypeEnum,
  type JsonNested,
  type ScoreDomain,
  type ScoreFieldGroupV3,
} from "@peri-fuse/shared";
import {
  DateTimeFilter,
  encodeCursorV3,
  FilterList,
  getTelemetryDB,
  liteBuildFilterWhere,
  NumberFilter,
  StringOptionsFilter,
  scoreDomainToV3,
} from "@peri-fuse/shared/src/server";

/** v3 list query params after route-level parsing + validation. */
export type ScoresV3ListParams = {
  projectId: string;
  limit: number;
  fields: ScoreFieldGroupV3[];
  cursor?: { lastTimestamp: Date; lastId: string };
  id?: string[];
  name?: string[];
  source?: string[];
  dataType?: string[];
  environment?: string[];
  configId?: string[];
  queueId?: string[];
  authorUserId?: string[];
  value?: string[];
  valueMin?: number;
  valueMax?: number;
  traceId?: string[];
  sessionId?: string[];
  observationId?: string[];
  experimentId?: string[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
};

/** SQLite datetime storage format: 'YYYY-MM-DD HH:MM:SS.mmm' (UTC). */
function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

/** Parse a JSON column safely (SQLite stores metadata as TEXT). */
function parseMetadata(value: unknown): Record<string, JsonNested> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") return value as Record<string, JsonNested>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, JsonNested>) : {};
  } catch {
    return {};
  }
}

/** 1 → true / 0 → false for BOOLEAN value filters. */
function booleanValueToNumber(v: string): number {
  if (v === "true") return 1;
  if (v === "false") return 0;
  throw new Error(`BOOLEAN value filter received unexpected value: ${v}`);
}

/**
 * Build the FilterList for the v3 list query (excluding the `value` filter,
 * which is dataType-dependent and compiled separately).
 */
function buildV3Filters(params: ScoresV3ListParams): FilterList {
  const filterList = new FilterList();

  const stringOptions: Array<{ key: keyof ScoresV3ListParams; field: string }> = [
    { key: "id", field: "id" },
    { key: "name", field: "name" },
    { key: "source", field: "source" },
    { key: "dataType", field: "data_type" },
    { key: "environment", field: "environment" },
    { key: "configId", field: "config_id" },
    { key: "queueId", field: "queue_id" },
    { key: "authorUserId", field: "author_user_id" },
    { key: "traceId", field: "trace_id" },
    { key: "sessionId", field: "session_id" },
    { key: "observationId", field: "observation_id" },
    { key: "experimentId", field: "dataset_run_id" },
  ];
  for (const { key, field } of stringOptions) {
    const values = params[key];
    if (Array.isArray(values) && values.length > 0) {
      filterList.push(
        new StringOptionsFilter({
          clickhouseTable: "scores",
          field,
          operator: "any of",
          values,
          tablePrefix: "s",
        }),
      );
    }
  }
  if (params.fromTimestamp !== undefined) {
    filterList.push(
      new DateTimeFilter({
        clickhouseTable: "scores",
        field: "timestamp",
        operator: ">=",
        value: params.fromTimestamp,
        tablePrefix: "s",
      }),
    );
  }
  if (params.toTimestamp !== undefined) {
    filterList.push(
      new DateTimeFilter({
        clickhouseTable: "scores",
        field: "timestamp",
        operator: "<",
        value: params.toTimestamp,
        tablePrefix: "s",
      }),
    );
  }
  if (params.valueMin !== undefined) {
    filterList.push(
      new NumberFilter({
        clickhouseTable: "scores",
        field: "value",
        operator: ">=",
        value: params.valueMin,
        tablePrefix: "s",
      }),
    );
  }
  if (params.valueMax !== undefined) {
    filterList.push(
      new NumberFilter({
        clickhouseTable: "scores",
        field: "value",
        operator: "<=",
        value: params.valueMax,
        tablePrefix: "s",
      }),
    );
  }
  return filterList;
}

/**
 * Compile the `value` filter (exact-match list) into SQL. Requires the route
 * to have validated that dataType is a single NUMERIC/BOOLEAN/CATEGORICAL.
 */
function buildValueFilterClause(
  values: string[],
  dataType: string,
): { clause: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const placeholders = values.map((v, i) => {
    const p = `val${i}`;
    if (dataType === ScoreDataTypeEnum.NUMERIC) {
      params[p] = Number(v);
    } else if (dataType === ScoreDataTypeEnum.BOOLEAN) {
      params[p] = booleanValueToNumber(v);
    } else {
      params[p] = v;
    }
    return `@${p}`;
  });
  const column = dataType === ScoreDataTypeEnum.CATEGORICAL ? "string_value" : "value";
  return { clause: `${column} IN (${placeholders.join(",")})`, params };
}

/** Field-group-dependent SELECT columns (dataset_run_id has no lite column). */
function buildSelectColumns(fields: ScoreFieldGroupV3[]): string {
  const columns = [
    "s.id as id",
    "s.project_id as project_id",
    "s.timestamp as timestamp",
    "s.environment as environment",
    "s.name as name",
    "s.value as value",
    "s.string_value as string_value",
    "s.source as source",
    "s.data_type as data_type",
    "s.created_at as created_at",
    "s.updated_at as updated_at",
  ];
  if (fields.includes("details")) {
    columns.push("s.comment as comment", "s.metadata as metadata", "s.config_id as config_id");
  }
  if (fields.includes("subject")) {
    columns.push(
      "s.trace_id as trace_id",
      "s.observation_id as observation_id",
      "s.session_id as session_id",
    );
  }
  if (fields.includes("annotation")) {
    columns.push("s.author_user_id as author_user_id", "s.queue_id as queue_id");
  }
  return columns.join(", ");
}

/**
 * Convert a raw scores row to the shared ScoreDomain shape.
 *
 * NOTE: this deliberately does NOT go through convertClickhouseScoreToDomain —
 * its lite-mode date stub (`new Date(value)`) parses SQLite's
 * 'YYYY-MM-DD HH:MM:SS.mmm' strings as LOCAL time, shifting every timestamp by
 * the host timezone. SQLite stores UTC; we append `Z` explicitly.
 */
function rowToScoreDomain(row: Record<string, unknown>): ScoreDomain {
  const toUtcDate = (v: unknown) => new Date(`${String(v).replace(" ", "T")}Z`);
  const base = {
    id: String(row.id),
    timestamp: toUtcDate(row.timestamp),
    projectId: String(row.project_id),
    environment: String(row.environment ?? "default"),
    traceId: row.trace_id ? String(row.trace_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    observationId: row.observation_id ? String(row.observation_id) : null,
    datasetRunId: null,
    name: String(row.name),
    value: row.value != null ? Number(row.value) : 0,
    longStringValue: row.string_value ? String(row.string_value) : "",
    source: String(row.source ?? "API") as ScoreDomain["source"],
    comment: row.comment ? String(row.comment) : null,
    authorUserId: row.author_user_id ? String(row.author_user_id) : null,
    configId: row.config_id ? String(row.config_id) : null,
    queueId: row.queue_id ? String(row.queue_id) : null,
    executionTraceId: null,
    createdAt: toUtcDate(row.created_at),
    updatedAt: toUtcDate(row.updated_at),
    metadata: parseMetadata(row.metadata),
  };
  if (row.data_type === ScoreDataTypeEnum.NUMERIC) {
    return { ...base, dataType: ScoreDataTypeEnum.NUMERIC, stringValue: null };
  }
  if (row.data_type === ScoreDataTypeEnum.CORRECTION) {
    return { ...base, dataType: ScoreDataTypeEnum.CORRECTION, stringValue: null };
  }
  return {
    ...base,
    dataType: String(row.data_type ?? "NUMERIC") as "CATEGORICAL" | "BOOLEAN" | "TEXT",
    stringValue: row.string_value ? String(row.string_value) : "",
  };
}

/**
 * List scores (v3 semantics) with keyset cursor pagination.
 * Returns the page plus the next cursor (undefined on the final page).
 */
export async function listScoresV3ForPublicApiLite(params: ScoresV3ListParams): Promise<{
  data: ReturnType<typeof scoreDomainToV3>[];
  cursor?: string;
}> {
  // Lite has no dataset-run scores: the scores table carries no
  // dataset_run_id column, so an experimentId filter matches nothing.
  if (params.experimentId?.length) {
    return { data: [] };
  }

  const filterList = buildV3Filters(params);
  const { clause, params: filterParams } = liteBuildFilterWhere(filterList, "scores");

  const where: string[] = ["s.project_id = @projectId AND s.is_deleted = 0"];
  const bind: Record<string, unknown> = { projectId: params.projectId };

  if (params.cursor) {
    where.push("(s.timestamp, s.id) < (@lastTimestamp, @lastId)");
    bind.lastTimestamp = toSqliteDateTime(params.cursor.lastTimestamp);
    bind.lastId = params.cursor.lastId;
  }
  if (clause) where.push(clause);

  if (params.value?.length && params.dataType?.length === 1) {
    const valueClause = buildValueFilterClause(params.value, params.dataType[0]);
    where.push(valueClause.clause);
    Object.assign(bind, valueClause.params);
  }

  const db = getTelemetryDB();
  const rows = await db.query<Record<string, unknown>>({
    query: `
      SELECT ${buildSelectColumns(params.fields)}
      FROM scores s
      WHERE ${where.join(" AND ")}
      ORDER BY s.timestamp DESC, s.id DESC
      LIMIT @limit
    `,
    params: { ...bind, ...filterParams, limit: params.limit + 1 },
  });

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;

  let cursor: string | undefined;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    cursor = encodeCursorV3({
      v: 1,
      lastTimestamp: new Date(`${String(last.timestamp).replace(" ", "T")}Z`),
      lastId: String(last.id),
    });
  }

  const data: Array<ReturnType<typeof scoreDomainToV3>> = [];
  for (const row of pageRows) {
    data.push(scoreDomainToV3(rowToScoreDomain(row), params.fields));
  }
  return { data, cursor };
}
