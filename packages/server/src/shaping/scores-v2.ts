/**
 * v2 scores filter building + API shaping (GET /api/public/v2/scores).
 *
 * v2 is the superset of v1 GET /scores: it lists trace, observation AND
 * session scores (no LISTABLE_SCORE_TYPES restriction), supports the same
 * simple filters plus sessionId/datasetRunId/traceId/observationId, and
 * includes an optional `trace` field group populated from a JOIN on the
 * `traces` table (userId/tags/environment/sessionId).
 *
 * Lite mode: filters are built as FilterList instances (same builders as v1)
 * and compiled to SQLite SQL via liteBuildFilterWhere, with trace-property
 * filters (userId/traceTags) lowered to EXISTS subqueries on `traces`.
 */
import {
  type JsonNested,
  ScoreDataTypeEnum,
  type ScoreDomain,
  scoresTableCols,
} from "@peri-fuse/shared";
import {
  convertApiProvidedFilterToClickhouseFilter,
  deriveFilters,
  FilterList,
  getTelemetryDB,
  liteBuildFilterWhere,
  liteGetTraceInfoByIds,
  type ScoreQueryType,
  StringFilter,
  scoresTableUiColumnDefinitions,
} from "@peri-fuse/shared/src/server";
import { convertScoreToPublicApi } from "./scores";

const secureScoreFilterOptions = [
  {
    id: "traceId",
    clickhouseSelect: "trace_id",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "observationId",
    clickhouseSelect: "observation_id",
    clickhouseTable: "scores",
    filterType: "StringOptionsFilter",
    clickhousePrefix: "s",
  },
  {
    id: "name",
    clickhouseSelect: "name",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    operator: "contains",
    clickhousePrefix: "s",
  },
  {
    id: "source",
    clickhouseSelect: "source",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "fromTimestamp",
    clickhouseSelect: "timestamp",
    operator: ">=" as const,
    clickhouseTable: "scores",
    filterType: "DateTimeFilter",
    clickhousePrefix: "s",
  },
  {
    id: "toTimestamp",
    clickhouseSelect: "timestamp",
    operator: "<" as const,
    clickhouseTable: "scores",
    filterType: "DateTimeFilter",
    clickhousePrefix: "s",
  },
  {
    id: "value",
    clickhouseSelect: "value",
    clickhouseTable: "scores",
    filterType: "NumberFilter",
    clickhousePrefix: "s",
  },
  {
    id: "scoreIds",
    clickhouseSelect: "id",
    clickhouseTable: "scores",
    filterType: "StringOptionsFilter",
    clickhousePrefix: "s",
  },
  {
    id: "configId",
    clickhouseSelect: "config_id",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "sessionId",
    clickhouseSelect: "session_id",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "datasetRunId",
    clickhouseSelect: "dataset_run_id",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "queueId",
    clickhouseSelect: "queue_id",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "environment",
    clickhouseSelect: "environment",
    clickhouseTable: "scores",
    filterType: "StringOptionsFilter",
    clickhousePrefix: "s",
  },
  {
    id: "dataType",
    clickhouseSelect: "data_type",
    clickhouseTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
];

const secureTraceFilterOptions = [
  {
    id: "traceTags",
    clickhouseSelect: "tags",
    clickhouseTable: "traces",
    filterType: "ArrayOptionsFilter",
    clickhousePrefix: "t",
  },
  {
    id: "userId",
    clickhouseSelect: "user_id",
    clickhouseTable: "traces",
    filterType: "StringFilter",
    clickhousePrefix: "t",
  },
];

/**
 * Build the scores-table and traces-table FilterLists for a v2 query.
 * Mirrors the v1 builder but without the LISTABLE_SCORE_TYPES restriction.
 */
function buildScoreFiltersV2(props: ScoreQueryType): {
  scoresFilter: FilterList;
  tracesFilter: FilterList;
} {
  const scoresFilter = deriveFilters(
    props,
    secureScoreFilterOptions,
    props.advancedFilters,
    scoresTableUiColumnDefinitions,
    scoresTableCols,
  );
  scoresFilter.push(
    new StringFilter({
      clickhouseTable: "scores",
      field: "project_id",
      operator: "=",
      value: props.projectId,
    }),
  );

  const tracesFilter = convertApiProvidedFilterToClickhouseFilter(props, secureTraceFilterOptions);

  return { scoresFilter, tracesFilter };
}

function determineTraceJoinRequirement(
  fields: string[] | null | undefined,
  tracesFilterLength: number,
) {
  const requestedFields = fields ?? ["score", "trace"];
  const includeTrace = requestedFields.includes("trace");
  const needsTraceJoin = includeTrace || tracesFilterLength > 0;
  return { includeTrace, needsTraceJoin };
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

/** Normalize a SQLite datetime string to the ClickHouse-compatible shape. */
function toDateStr(value: unknown): string {
  if (!value) return new Date().toISOString().replace("T", " ").replace("Z", "");
  const s = String(value);
  return s.includes(".") ? s : `${s}.000000`;
}

/** Map a raw scores row to the ScoreRecordReadType shape the domain converter expects. */
function rowToScoreRecord(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    trace_id: row.trace_id ? String(row.trace_id) : null,
    session_id: row.session_id ? String(row.session_id) : null,
    observation_id: row.observation_id ? String(row.observation_id) : null,
    dataset_run_id: null,
    environment: String(row.environment ?? "default"),
    name: String(row.name),
    value: row.value != null ? Number(row.value) : 0,
    source: String(row.source ?? "API"),
    comment: row.comment ? String(row.comment) : null,
    metadata: parseMetadata(row.metadata),
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
  };
}

/**
 * Get a paginated list of scores (v2 semantics).
 * Returns API-shaped scores, each with an optional `trace` object when the
 * `trace` field group is requested.
 */
export async function generateScoresForPublicApiV2(props: ScoreQueryType) {
  const { scoresFilter, tracesFilter } = buildScoreFiltersV2(props);
  const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
    props.fields,
    tracesFilter.length,
  );

  // The traces-table filters (userId/traceTags) are lowered to EXISTS
  // subqueries by liteBuildFilterWhere when the combined list is compiled
  // against the `scores` table. project_id is enforced by the base query.
  const merged = new FilterList([...scoresFilter, ...tracesFilter]);
  const { clause, params: filterParams } = liteBuildFilterWhere(merged, "scores");

  const db = getTelemetryDB();
  const offset = props.limit * (props.page - 1);
  const rows = await db.query<Record<string, unknown>>({
    query: `
      SELECT * FROM scores
      WHERE project_id = @projectId AND is_deleted = 0
      ${clause ? `AND ${clause}` : ""}
      ORDER BY timestamp DESC, id DESC
      LIMIT @limit OFFSET @offset
    `,
    params: { projectId: props.projectId, limit: props.limit, offset, ...filterParams },
  });

  // Enrich with trace attribution info when the trace group is requested.
  let traceInfo: Map<
    string,
    { userId: string | null; tags: string[]; environment: string | null; sessionId: string | null }
  > = new Map();
  if (needsTraceJoin) {
    const traceIds = [
      ...new Set(rows.map((r) => r.trace_id).filter((id): id is string => Boolean(id))),
    ];
    traceInfo = await liteGetTraceInfoByIds(props.projectId, traceIds);
  }

  return rows.map((row) => {
    const record = rowToScoreRecord(row);
    const domain = convertRowToDomain(record);
    const trace = record.trace_id ? traceInfo.get(record.trace_id) : undefined;
    if (includeTrace) {
      return {
        ...convertScoreToPublicApi(domain),
        trace: {
          userId: trace?.userId ?? null,
          tags: trace?.tags ?? [],
          environment: trace?.environment ?? null,
          sessionId: trace?.sessionId ?? null,
        },
      };
    }
    return convertScoreToPublicApi(domain);
  });
}

/**
 * Get the total item count for a v2 query (same filters as the list query).
 */
export async function getScoresCountForPublicApiV2(props: ScoreQueryType): Promise<number> {
  const { scoresFilter, tracesFilter } = buildScoreFiltersV2(props);
  const merged = new FilterList([...scoresFilter, ...tracesFilter]);
  const { clause, params: filterParams } = liteBuildFilterWhere(merged, "scores");

  const db = getTelemetryDB();
  const rows = await db.query<{ count: number }>({
    query: `
      SELECT COUNT(*) as count FROM scores
      WHERE project_id = @projectId AND is_deleted = 0
      ${clause ? `AND ${clause}` : ""}
    `,
    params: { projectId: props.projectId, ...filterParams },
  });
  return Number(rows[0]?.count ?? 0);
}

/**
 * Get a single score by id (v2 semantics). Returns undefined when not found
 * or deleted so the route can answer 404.
 */
export async function getScoreByIdForPublicApiV2(
  projectId: string,
  scoreId: string,
): Promise<ReturnType<typeof convertScoreToPublicApi> | undefined> {
  const db = getTelemetryDB();
  const rows = await db.query<Record<string, unknown>>({
    query: `
      SELECT * FROM scores
      WHERE project_id = @projectId AND id = @scoreId AND is_deleted = 0
      LIMIT 1
    `,
    params: { projectId, scoreId },
  });
  const row = rows[0];
  if (!row) return undefined;
  return convertScoreToPublicApi(convertRowToDomain(rowToScoreRecord(row)));
}

/** Convert a score record to the shared ScoreDomain shape. */
function convertRowToDomain(record: ReturnType<typeof rowToScoreRecord>): ScoreDomain {
  // SQLite stores UTC datetimes as 'YYYY-MM-DD HH:MM:SS.mmm'; parse explicitly
  // as UTC so timestamps survive the round-trip unchanged in any timezone.
  const toUtcDate = (v: string) => new Date(`${v.replace(" ", "T")}Z`);
  const base = {
    id: record.id,
    timestamp: toUtcDate(record.timestamp),
    projectId: record.project_id,
    environment: record.environment,
    traceId: record.trace_id ?? null,
    sessionId: record.session_id ?? null,
    observationId: record.observation_id ?? null,
    datasetRunId: null,
    name: record.name,
    value: record.value,
    longStringValue: record.long_string_value ?? "",
    source: record.source as ScoreDomain["source"],
    comment: record.comment ?? null,
    authorUserId: record.author_user_id ?? null,
    configId: record.config_id ?? null,
    queueId: record.queue_id ?? null,
    executionTraceId: null,
    createdAt: toUtcDate(record.created_at),
    updatedAt: toUtcDate(record.updated_at),
    metadata: record.metadata,
  };
  if (record.data_type === ScoreDataTypeEnum.NUMERIC) {
    return { ...base, dataType: ScoreDataTypeEnum.NUMERIC, stringValue: null };
  }
  if (record.data_type === ScoreDataTypeEnum.CORRECTION) {
    return { ...base, dataType: ScoreDataTypeEnum.CORRECTION, stringValue: null };
  }
  return {
    ...base,
    dataType: record.data_type as "CATEGORICAL" | "BOOLEAN" | "TEXT",
    stringValue: record.string_value ?? "",
  };
}
