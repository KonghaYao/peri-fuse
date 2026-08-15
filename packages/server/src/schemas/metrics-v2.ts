/**
 * GET /api/public/v2/metrics query schemas + view catalog.
 *
 * The OpenAPI spec (/tmp/lf-v4.10.0.yml) declares the `query` parameter as a
 * plain string with an EMPTY object schema; the real structure lives in the
 * parameter description only. This file ports that documented structure:
 *
 *   { view, dimensions: [{field}], metrics: [{measure, aggregation}],
 *     filters: [...], timeDimension: {granularity}, fromTimestamp,
 *     toTimestamp, orderBy: [{field, direction}], config: {bins, row_limit} }
 *
 * View catalogs mirror langfuse v4.10.0 `viewDeclarations` (v2 version) —
 * observations / scores-numeric / scores-boolean / scores-categorical —
 * mapped onto the lite telemetry tables (observations / traces / scores).
 * Column aliases are hardcoded (`o`, `t`, `s`, `ob`); every SQL fragment
 * originates here, never from user input.
 */
import { z } from "zod";

export const METRIC_VIEWS = [
  "observations",
  "scores-numeric",
  "scores-boolean",
  "scores-categorical",
] as const;
export type MetricViewName = (typeof METRIC_VIEWS)[number];

/** Aggregations advertised by the spec description (11 values, no `uniq`). */
export const METRIC_AGGREGATIONS = [
  "sum",
  "avg",
  "count",
  "max",
  "min",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "histogram",
] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export type DimensionDef = {
  /** SQL expression referencing the view's table aliases. */
  sql: string;
  type: "string" | "number" | "boolean" | "string[]";
  /** High-cardinality fields are filter-only (groupBy → 400). */
  highCardinality?: boolean;
};

export type MeasureDef = {
  /** Per-row expression; aggregations are applied on top. */
  rawSql: string;
  type: "integer" | "decimal" | "number";
};

export type MetricViewDef = {
  dimensions: Record<string, DimensionDef>;
  measures: Record<string, MeasureDef>;
  /** Implicit view segment filter (e.g. scores-numeric → NUMERIC/BOOLEAN). */
  segmentSql: string | null;
  /** Time column for from/to bounding + timeDimension bucketing. */
  timeColumn: string;
  /** Base table (used for is_deleted filtering and FROM). */
  baseTable: string;
};

const OBS_TIME_COL = "o.start_time";

/** Dimensions shared by all three scores views (spec scores-numeric list). */
const scoreSharedDimensions: Record<string, DimensionDef> = {
  id: { sql: "s.id", type: "string", highCardinality: true },
  traceId: { sql: "s.trace_id", type: "string", highCardinality: true },
  userId: { sql: "t.user_id", type: "string", highCardinality: true },
  sessionId: { sql: "t.session_id", type: "string", highCardinality: true },
  observationId: {
    sql: "s.observation_id",
    type: "string",
    highCardinality: true,
  },
  environment: { sql: "s.environment", type: "string" },
  name: { sql: "s.name", type: "string" },
  source: { sql: "s.source", type: "string" },
  dataType: { sql: "s.data_type", type: "string" },
  configId: { sql: "s.config_id", type: "string" },
  timestampMonth: { sql: "strftime('%Y-%m', s.timestamp)", type: "string" },
  timestampDay: { sql: "strftime('%Y-%m-%d', s.timestamp)", type: "string" },
  traceName: { sql: "t.name", type: "string" },
  tags: { sql: "t.tags", type: "string[]" },
  traceRelease: { sql: "t.release", type: "string" },
  traceVersion: { sql: "t.version", type: "string" },
  observationName: { sql: "ob.name", type: "string" },
  observationModelName: { sql: "ob.model", type: "string" },
  observationPromptName: { sql: "ob.prompt_name", type: "string" },
  observationPromptVersion: { sql: "ob.prompt_version", type: "number" },
};

export const METRICS_VIEW_DEFS: Record<MetricViewName, MetricViewDef> = {
  observations: {
    baseTable: "observations o",
    timeColumn: OBS_TIME_COL,
    segmentSql: null,
    dimensions: {
      id: { sql: "o.id", type: "string", highCardinality: true },
      traceId: { sql: "o.trace_id", type: "string", highCardinality: true },
      environment: { sql: "o.environment", type: "string" },
      type: { sql: "o.type", type: "string" },
      name: { sql: "o.name", type: "string" },
      level: { sql: "o.level", type: "string" },
      version: { sql: "o.version", type: "string" },
      // lite observations have no tags/release columns; the denormalized
      // trace fields carry them (events-table semantics in upstream).
      tags: { sql: "t.tags", type: "string[]" },
      release: { sql: "t.release", type: "string" },
      traceName: { sql: "t.name", type: "string" },
      traceRelease: { sql: "t.release", type: "string" },
      traceVersion: { sql: "t.version", type: "string" },
      providedModelName: { sql: "o.model", type: "string" },
      promptName: { sql: "o.prompt_name", type: "string" },
      promptVersion: { sql: "o.prompt_version", type: "number" },
      // Upstream: (parent_span_id = '' OR is_app_root = true). lite has no
      // is_app_root column — physical roots are the approximation.
      isRootObservation: {
        sql: "(o.parent_observation_id IS NULL OR o.parent_observation_id = '')",
        type: "boolean",
      },
      startTimeMonth: { sql: "strftime('%Y-%m', o.start_time)", type: "string" },
      userId: { sql: "t.user_id", type: "string", highCardinality: true },
      sessionId: { sql: "t.session_id", type: "string", highCardinality: true },
      parentObservationId: {
        sql: "o.parent_observation_id",
        type: "string",
        highCardinality: true,
      },
    },
    measures: {
      count: { rawSql: "1", type: "integer" },
      latency: {
        rawSql: "(julianday(o.end_time) - julianday(o.start_time)) * 86400000.0",
        type: "decimal",
      },
      streamingLatency: {
        rawSql: "(julianday(o.end_time) - julianday(o.completion_start_time)) * 86400000.0",
        type: "decimal",
      },
      inputTokens: {
        rawSql: "COALESCE(json_extract(o.usage_details, '$.input'), 0)",
        type: "integer",
      },
      outputTokens: {
        rawSql: "COALESCE(json_extract(o.usage_details, '$.output'), 0)",
        type: "integer",
      },
      totalTokens: {
        rawSql:
          "COALESCE(json_extract(o.usage_details, '$.total'), json_extract(o.usage_details, '$.input') + json_extract(o.usage_details, '$.output'), 0)",
        type: "integer",
      },
      outputTokensPerSecond: {
        // NULLIF(0) guards the zero-duration case (NULL result, like upstream).
        rawSql:
          "COALESCE(json_extract(o.usage_details, '$.output'), 0) / NULLIF((julianday(o.end_time) - julianday(o.completion_start_time)) * 86400.0, 0)",
        type: "decimal",
      },
      tokensPerSecond: {
        rawSql:
          "COALESCE(json_extract(o.usage_details, '$.total'), json_extract(o.usage_details, '$.input') + json_extract(o.usage_details, '$.output'), 0) / NULLIF((julianday(o.end_time) - julianday(o.start_time)) * 86400.0, 0)",
        type: "decimal",
      },
      inputCost: {
        rawSql: "COALESCE(json_extract(o.cost_details, '$.input'), 0)",
        type: "decimal",
      },
      outputCost: {
        rawSql: "COALESCE(json_extract(o.cost_details, '$.output'), 0)",
        type: "decimal",
      },
      totalCost: { rawSql: "COALESCE(o.total_cost, 0)", type: "decimal" },
      timeToFirstToken: {
        rawSql: "(julianday(o.completion_start_time) - julianday(o.start_time)) * 86400000.0",
        type: "decimal",
      },
      countScores: {
        rawSql:
          "(SELECT COUNT(*) FROM scores sc WHERE sc.project_id = o.project_id AND sc.observation_id = o.id AND sc.is_deleted = 0)",
        type: "integer",
      },
    },
  },

  "scores-numeric": {
    baseTable: "scores s",
    timeColumn: "s.timestamp",
    segmentSql: "s.data_type IN ('NUMERIC', 'BOOLEAN')",
    dimensions: {
      ...scoreSharedDimensions,
      value: { sql: "s.value", type: "number" },
    },
    measures: {
      count: { rawSql: "1", type: "integer" },
      value: { rawSql: "s.value", type: "number" },
    },
  },

  "scores-boolean": {
    baseTable: "scores s",
    timeColumn: "s.timestamp",
    segmentSql: "s.data_type = 'BOOLEAN'",
    dimensions: {
      ...scoreSharedDimensions,
      booleanValue: { sql: "(s.value = 1)", type: "boolean" },
    },
    measures: {
      count: { rawSql: "1", type: "integer" },
      // Numeric 0/1 value; avg over it yields the true-rate.
      value: { rawSql: "s.value", type: "number" },
    },
  },

  "scores-categorical": {
    baseTable: "scores s",
    timeColumn: "s.timestamp",
    segmentSql: "s.data_type = 'CATEGORICAL'",
    dimensions: {
      ...scoreSharedDimensions,
      stringValue: { sql: "s.string_value", type: "string" },
    },
    measures: {
      count: { rawSql: "1", type: "integer" },
    },
  },
};

export const METRIC_GRANULARITIES = ["auto", "minute", "hour", "day", "week", "month"] as const;
export type MetricGranularity = (typeof METRIC_GRANULARITIES)[number];

/** Filters: 10 data types from the spec description, validated per type. */
export const MetricsV2FilterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("datetime"),
    column: z.string(),
    operator: z.enum([">", "<", ">=", "<="]),
    value: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), {
      message: "Invalid datetime value",
    }),
  }),
  z.object({
    type: z.literal("string"),
    column: z.string(),
    operator: z.enum(["=", "contains", "does not contain", "starts with", "ends with"]),
    value: z.string(),
  }),
  z.object({
    type: z.literal("number"),
    column: z.string(),
    operator: z.enum(["=", ">", "<", ">=", "<="]),
    value: z.number(),
  }),
  z.object({
    type: z.literal("stringOptions"),
    column: z.string(),
    operator: z.enum(["any of", "none of"]),
    value: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("categoryOptions"),
    column: z.string(),
    key: z.string(),
    operator: z.enum(["any of", "none of"]),
    value: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("arrayOptions"),
    column: z.string(),
    operator: z.enum(["any of", "none of", "all of"]),
    value: z.array(z.string()),
  }),
  z.object({
    type: z.literal("stringObject"),
    column: z.string(),
    key: z.string(),
    operator: z.enum(["=", "contains", "does not contain", "starts with", "ends with"]),
    value: z.string(),
  }),
  z.object({
    type: z.literal("numberObject"),
    column: z.string(),
    key: z.string(),
    operator: z.enum(["=", ">", "<", ">=", "<="]),
    value: z.number(),
  }),
  z.object({
    type: z.literal("boolean"),
    column: z.string(),
    operator: z.enum(["=", "<>"]),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal("null"),
    column: z.string(),
    operator: z.enum(["is null", "is not null"]),
    value: z.unknown().optional(),
  }),
]);
export type MetricsV2Filter = z.infer<typeof MetricsV2FilterSchema>;

const isoDateTime = z.iso.datetime({ offset: true });

export const MetricsV2QuerySchema = z
  .object({
    view: z.enum(METRIC_VIEWS),
    dimensions: z
      .array(z.object({ field: z.string() }))
      .optional()
      .default([]),
    metrics: z
      .array(
        z.object({
          measure: z.string(),
          aggregation: z.enum(METRIC_AGGREGATIONS),
        }),
      )
      .min(1),
    filters: z.array(MetricsV2FilterSchema).optional().default([]),
    timeDimension: z
      .object({ granularity: z.enum(METRIC_GRANULARITIES) })
      .nullable()
      .optional()
      .default(null),
    fromTimestamp: isoDateTime,
    toTimestamp: isoDateTime,
    orderBy: z
      .array(
        z.object({
          field: z.string(),
          direction: z.enum(["asc", "desc"]),
        }),
      )
      .nullable()
      .optional()
      .default(null),
    config: z
      .object({
        bins: z.number().int().min(1).max(100).optional(),
        row_limit: z.number().int().min(1).max(1000).optional(),
      })
      .optional(),
  })
  .refine((q) => new Date(q.fromTimestamp).getTime() < new Date(q.toTimestamp).getTime(), {
    message: "fromTimestamp must be before toTimestamp",
  });

export type MetricsV2Query = z.infer<typeof MetricsV2QuerySchema>;
