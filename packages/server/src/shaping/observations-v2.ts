/**
 * v2 observations: SQLite keyset-pagination query + DB→API shaping.
 *
 * Data shape mirrors the v1 public API (same `observations` table, same
 * domain conversion), with v2 additions: keyset pagination on (start_time,
 * id), field-group selection, metadata truncation. Filter
 * building reuses the shared lite pipeline (deriveFilters →
 * createFilterFromFilterState → liteBuildFilterWhere), including the
 * T0-extended boolean/null/json_extract filter types.
 */
import type { EventsObservation, FilterState } from "@peri-fuse/shared";
import {
  createPublicApiObservationsColumnMapping,
  deriveFilters,
  type EventsObservationRecordReadType,
  liteBuildFilterWhere,
  type ObservationPriceFields,
  type RenderingProps,
  StringFilter,
} from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import type { ObservationV2FieldGroup } from "../schemas/observations-v2";

/** Keyset cursor payload (base64url-encoded by the route layer). */
export type ObservationsV2Cursor = {
  v: 1;
  lastStartTime: string;
  lastId: string;
};

// ============================================================================
// Row mapping helpers (same conventions as lite-queries.ts)
// ============================================================================

/** Parse a JSON string safely, returning fallback on failure. */
function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Convert SQLite boolean (0/1) to JS boolean. */
function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

/** Ensure a date string from SQLite is in ClickHouse-compatible format. */
function toDateStr(value: unknown): string {
  if (!value) return new Date().toISOString().replace("T", " ").replace("Z", "");
  const s = String(value);
  // If it already has fractional seconds, return as-is
  if (s.includes(".")) return s;
  return `${s}.000000`;
}

/** Parse a usage/cost details field from SQLite (JSON string) to Record<string, number>. */
function toUsageRecord(value: unknown): Record<string, number> {
  const obj = safeJsonParse<Record<string, unknown>>(value, {});
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) {
      const num = Number(v);
      if (!Number.isNaN(num)) {
        result[k] = num;
      }
    }
  }
  return result;
}

// ============================================================================
// Filter building
// ============================================================================

/**
 * Simple-parameter column mapping: mirrors the v1 mapping plus `sessionId`
 * (traces table). Unquoted names keep the lite whitelist happy.
 */
const v2ObservationsSimpleFilterParams = [
  ...createPublicApiObservationsColumnMapping("observations", "o", "parent_observation_id"),
  {
    id: "sessionId",
    clickhouseSelect: "session_id",
    filterType: "StringFilter",
    clickhouseTable: "traces",
    clickhousePrefix: "t",
  },
];

/**
 * UI column definitions for `filter` JSON conditions. Unquoted (whitelist
 * compatible); observations-table columns only, plus traces user_id which
 * liteBuildFilterWhere resolves via subquery.
 */
const col = (
  uiTableId: string,
  uiTableName: string,
  clickhouseTableName: string,
  clickhouseSelect: string,
) => ({ uiTableId, uiTableName, clickhouseTableName, clickhouseSelect });

const v2ObservationsUiColumnDefinitions = [
  col("name", "Name", "observations", "name"),
  col("type", "Type", "observations", "type"),
  col("level", "Level", "observations", "level"),
  col("environment", "Environment", "observations", "environment"),
  col("version", "Version", "observations", "version"),
  col("id", "ID", "observations", "id"),
  col("traceId", "Trace ID", "observations", "trace_id"),
  col("parentObservationId", "Parent Observation ID", "observations", "parent_observation_id"),
  col("startTime", "Start Time", "observations", "start_time"),
  col("endTime", "End Time", "observations", "end_time"),
  col("model", "Model", "observations", "model"),
  // stringObject/numberObject filters with a key resolve to json_extract().
  col("metadata", "Metadata", "observations", "metadata"),
  // Traces-table columns: lowered to EXISTS subqueries on `traces` by
  // liteBuildFilterWhere (same as user_id).
  col("userId", "User ID", "traces", "user_id"),
  col("sessionId", "Session ID", "traces", "session_id"),
  col("traceName", "Trace Name", "traces", "trace_name"),
  col("traceTags", "Trace Tags", "traces", "tags"),
  col("tags", "Tags", "traces", "tags"),
];

/**
 * The SQLite observations table has no `is_root_observation` column: a
 * boolean filter on it is equivalent to a null filter on the physical parent
 * (lite mode has no app-root marking). Rewrite such conditions before the
 * shared factory sees them.
 */
function normalizeV2Filters(filters: FilterState | undefined): FilterState | undefined {
  if (!filters || filters.length === 0) return filters;
  return filters.map((f) => {
    if (
      typeof f === "object" &&
      f !== null &&
      (f as { type?: string }).type === "boolean" &&
      (f as { column?: string }).column === "isRootObservation"
    ) {
      const operator = (f as { operator?: string }).operator ?? "=";
      const value = (f as { value?: unknown }).value;
      const isNull = (operator === "=" && value === true) || (operator === "<>" && value === false);
      return {
        type: "null",
        column: "parentObservationId",
        operator: isNull ? "is null" : "is not null",
        value: "",
      };
    }
    return f;
  });
}

export type ObservationsV2QueryProps = {
  projectId: string;
  name?: string;
  userId?: string;
  sessionId?: string;
  type?: string;
  traceId?: string;
  level?: string;
  parentObservationId?: string;
  isRootObservation?: boolean;
  environment?: string | string[];
  fromStartTime?: string;
  toStartTime?: string;
  version?: string;
  advancedFilters?: FilterState;
};

/**
 * Build the FilterList for a v2 observations query (shared factory pipeline)
 * plus the project-scope filter.
 */
function buildObservationsV2Filter(props: ObservationsV2QueryProps) {
  const { advancedFilters, ...simpleFilterProps } = props;
  const filterList = deriveFilters(
    {
      page: 1,
      limit: 1,
      projectId: props.projectId,
      ...simpleFilterProps,
    },
    v2ObservationsSimpleFilterParams,
    normalizeV2Filters(advancedFilters),
    v2ObservationsUiColumnDefinitions,
  );

  filterList.push(
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: props.projectId,
    }),
  );
  return filterList;
}

const traceColumn = (column: string, alias = column) =>
  `(SELECT t.${column} FROM traces t WHERE t.id = o.trace_id AND t.project_id = o.project_id) AS ${alias}`;

/** Build a projection from field groups so omitted IO is never read from disk. */
export function buildObservationsV2Select(fields: ReadonlySet<ObservationV2FieldGroup>): string {
  const columns = [
    "o.id",
    "o.trace_id",
    "o.project_id",
    "o.type",
    "o.parent_observation_id",
    "o.start_time",
    "o.end_time",
  ];

  if (fields.has("basic")) {
    columns.push(
      "o.environment",
      "o.name",
      "o.level",
      "o.status_message",
      "o.version",
      traceColumn("user_id"),
      traceColumn("session_id"),
      traceColumn("bookmarked"),
      traceColumn("public"),
    );
  }
  if (fields.has("time")) {
    columns.push("o.completion_start_time", "o.created_at", "o.updated_at");
  }
  if (fields.has("io")) columns.push("o.input", "o.output");
  if (fields.has("metadata")) columns.push("o.metadata");
  if (fields.has("model")) columns.push("o.model", "o.model_parameters");
  if (fields.has("usage")) {
    columns.push(
      "o.provided_usage_details",
      "o.usage_details",
      "o.provided_cost_details",
      "o.cost_details",
      "o.total_cost",
    );
  }
  if (fields.has("prompt")) columns.push("o.prompt_id", "o.prompt_name", "o.prompt_version");
  if (fields.has("trace_context")) {
    columns.push(traceColumn("tags"), traceColumn("release"), traceColumn("name", "trace_name"));
  }
  return `SELECT\n    ${columns.join(",\n    ")}\n  FROM observations o`;
}

function mapObservationRow(row: Record<string, unknown>): EventsObservationRecordReadType {
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
    input: row.input ? String(row.input) : null,
    output: row.output ? String(row.output) : null,
    provided_model_name: row.model ? String(row.model) : null,
    internal_model_id: null,
    model_parameters: row.model_parameters ? String(row.model_parameters) : null,
    total_cost:
      row.total_cost !== null && row.total_cost !== undefined ? Number(row.total_cost) : null,
    usage_pricing_tier_id: null,
    usage_pricing_tier_name: null,
    prompt_id: row.prompt_id ? String(row.prompt_id) : null,
    prompt_name: row.prompt_name ? String(row.prompt_name) : null,
    prompt_version:
      row.prompt_version !== null && row.prompt_version !== undefined
        ? Number(row.prompt_version)
        : null,
    tool_definitions: undefined,
    tool_calls: undefined,
    tool_call_names: undefined,
    is_deleted: 0,
    start_time: toDateStr(row.start_time),
    end_time: row.end_time ? toDateStr(row.end_time) : null,
    completion_start_time: row.completion_start_time ? toDateStr(row.completion_start_time) : null,
    created_at: toDateStr(row.created_at),
    updated_at: toDateStr(row.updated_at),
    event_ts: toDateStr(row.event_ts),
    provided_usage_details: toUsageRecord(row.provided_usage_details),
    provided_cost_details: toUsageRecord(row.provided_cost_details),
    usage_details: toUsageRecord(row.usage_details),
    cost_details: toUsageRecord(row.cost_details),
    user_id: row.user_id ? String(row.user_id) : null,
    session_id: row.session_id ? String(row.session_id) : null,
    trace_name: row.trace_name ? String(row.trace_name) : null,
    release: row.release ? String(row.release) : null,
    tags: safeJsonParse<string[]>(row.tags, []),
    bookmarked: toBool(row.bookmarked),
    public: toBool(row.public),
  };
}

/**
 * Run the v2 observations query with keyset pagination.
 *
 * `limit` is the raw page size; the caller should pass `limit + 1` and use
 * the returned row count to detect whether another page exists.
 */
export async function generateObservationsV2ForPublicApi(
  props: ObservationsV2QueryProps & {
    limit: number;
    cursor?: ObservationsV2Cursor | null;
    fields: ReadonlySet<ObservationV2FieldGroup>;
  },
): Promise<EventsObservationRecordReadType[]> {
  const db = getTelemetryDB();
  const { projectId, limit, cursor, isRootObservation } = props;

  const filter = buildObservationsV2Filter(props);
  const { clause, params: filterParams } = liteBuildFilterWhere(filter, "observations");

  let whereClause = "o.project_id = @projectId AND o.is_deleted = 0";
  const params: Record<string, unknown> = { projectId };
  if (clause) {
    whereClause += ` AND ${clause}`;
    Object.assign(params, filterParams);
  }

  // sessionId lives on the traces table; liteBuildFilterWhere lowers the
  // simple-parameter and filter-JSON conditions to an EXISTS subquery on
  // `traces`, so no extra WHERE clause is needed here.

  // isRootObservation is derived from the physical parent in lite mode.
  if (isRootObservation !== undefined) {
    whereClause += isRootObservation
      ? " AND o.parent_observation_id IS NULL"
      : " AND o.parent_observation_id IS NOT NULL";
  }

  // Keyset condition: strictly "before" the last row of the previous page.
  if (cursor) {
    params.lastStartTime = cursor.lastStartTime;
    params.lastId = cursor.lastId;
    whereClause +=
      " AND (o.start_time < @lastStartTime OR (o.start_time = @lastStartTime AND o.id < @lastId))";
  }

  params.limit = limit;

  const rows = await db.query<Record<string, unknown>>({
    query: `
      ${buildObservationsV2Select(props.fields)}
      WHERE ${whereClause}
      ORDER BY o.start_time DESC, o.id DESC
      LIMIT @limit
    `,
    params,
  });

  return rows.map(mapObservationRow);
}

// ============================================================================
// DB → API shaping
// ============================================================================

export type ObservationsV2TransformOpts = {
  /** Field groups to include; `core` is always included by the caller. */
  fields: Set<ObservationV2FieldGroup>;
  /** Metadata keys exempt from truncation, or "all" to disable truncation. */
  expandMetadata?: string[] | "all";
};

const METADATA_TRUNCATION_LIMIT = 200;
const METADATA_TRUNCATION_SUFFIX = "...";

function truncateMetadata(
  metadata: EventsObservation["metadata"],
  expandMetadata: string[] | "all" | undefined,
): EventsObservation["metadata"] {
  if (!metadata || Object.keys(metadata).length === 0) return metadata;
  if (expandMetadata === "all") return metadata;
  const expand = new Set(expandMetadata ?? []);
  const result: EventsObservation["metadata"] = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && value.length > METADATA_TRUNCATION_LIMIT && !expand.has(key)) {
      result[key] = `${value.slice(0, METADATA_TRUNCATION_LIMIT)}${METADATA_TRUNCATION_SUFFIX}`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Convert a DB observation (with trace join data and model prices) into the
 * v2 API shape. Core fields (id/traceId/startTime/endTime/projectId/
 * parentObservationId/type) and the model price fields
 * (modelId/inputPrice/outputPrice/totalPrice) are always present; every other
 * field appears only when its field group is requested.
 *
 * Prices are serialized as decimal strings (spec: e.g. "0.0001") and are null
 * when the `model` group is not requested.
 */
export function transformDbToApiObservationV2(
  observation: EventsObservation & ObservationPriceFields,
  opts: ObservationsV2TransformOpts,
): Record<string, unknown> {
  const { fields } = opts;
  const include = (group: ObservationV2FieldGroup) => fields.has(group);
  const iso = (value: Date | null | undefined): string | null =>
    value ? value.toISOString() : null;

  const result: Record<string, unknown> = {
    // core (always present)
    id: observation.id,
    traceId: observation.traceId ?? null,
    startTime: iso(observation.startTime),
    endTime: iso(observation.endTime),
    projectId: observation.projectId,
    parentObservationId: observation.parentObservationId ?? null,
    type: observation.type,
    // model price fields (always present; null without the model group)
    modelId: include("model") ? (observation.internalModelId ?? null) : null,
    inputPrice: include("model") ? (observation.inputPrice?.toString() ?? null) : null,
    outputPrice: include("model") ? (observation.outputPrice?.toString() ?? null) : null,
    totalPrice: include("model") ? (observation.totalPrice?.toString() ?? null) : null,
  };

  if (include("basic")) {
    result.name = observation.name ?? null;
    result.level = observation.level ?? null;
    result.statusMessage = observation.statusMessage ?? null;
    result.version = observation.version ?? null;
    result.environment = observation.environment ?? null;
    result.bookmarked = observation.bookmarked ?? false;
    result.public = observation.public ?? false;
    result.userId = observation.userId ?? null;
    result.sessionId = observation.sessionId ?? null;
    result.isRootObservation = observation.parentObservationId == null;
  }

  if (include("time")) {
    result.completionStartTime = iso(observation.completionStartTime);
    result.createdAt = iso(observation.createdAt);
    result.updatedAt = iso(observation.updatedAt);
  }

  if (include("io")) {
    // input/output are rendered according to parseIoAsJson during conversion.
    result.input = observation.input ?? null;
    result.output = observation.output ?? null;
  }

  if (include("metadata")) {
    result.metadata = truncateMetadata(observation.metadata, opts.expandMetadata);
  }

  if (include("model")) {
    result.providedModelName = observation.model ?? null;
    result.internalModelId = observation.internalModelId ?? null;
    result.modelParameters = observation.modelParameters ?? null;
  }

  if (include("usage")) {
    result.usageDetails = observation.usageDetails ?? {};
    result.costDetails = observation.costDetails ?? {};
    result.totalCost = observation.totalCost ?? null;
    result.usagePricingTierName = observation.usagePricingTierName ?? null;
  }

  if (include("prompt")) {
    result.promptId = observation.promptId ?? null;
    result.promptName = observation.promptName ?? null;
    result.promptVersion = observation.promptVersion ?? null;
  }

  if (include("metrics")) {
    result.latency = observation.latency ?? null;
    result.timeToFirstToken = observation.timeToFirstToken ?? null;
  }

  if (include("trace_context")) {
    result.tags = observation.tags ?? null;
    result.release = observation.release ?? null;
    result.traceName = observation.traceName ?? null;
  }

  return result;
}

/** Rendering props for the domain conversion, driven by parseIoAsJson. */
export function observationsV2RenderingProps(parseIoAsJson: boolean): RenderingProps {
  return { truncated: false, shouldJsonParse: parseIoAsJson };
}
