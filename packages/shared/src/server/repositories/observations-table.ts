import type { ClickHouseClientConfigOptions } from "@clickhouse/client";
import { relationalFilter } from "@peri-fuse/shared/src/db/relational-filter";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { prisma } from "../../db";
import { models as modelsTable } from "../../db/schema/index.js";
import type { OrderByState } from "../../interfaces/orderBy";
import type { TracingSearchType } from "../../interfaces/search";
import { observationsTableCols } from "../../observationsTable";
import { matchesUiColumnMapping } from "../../tableDefinitions";
import type { FilterState } from "../../types";
import { convertDateToClickhouseDateTime } from "../clickhouse/client";
import {
  DateTimeFilter,
  FilterList,
  type FullObservations,
  orderByToClickhouseSql,
  StringFilter,
} from "../queries";
import { createFilterFromFilterState } from "../queries/clickhouse-sql/factory";
import { scoreBooleansAggregation } from "../queries/clickhouse-sql/query-fragments";
import { shouldSkipObservationsFinal } from "../queries/clickhouse-sql/query-options";
import { clickhouseSearchCondition } from "../queries/clickhouse-sql/search";
import {
  observationsTableTraceUiColumnDefinitions,
  observationsTableUiColumnDefinitions,
} from "../tableMappings";
import type { RenderingProps } from "../utils/rendering";
import { queryClickhouse } from "./clickhouse";
import { OBSERVATIONS_TO_TRACE_INTERVAL } from "./constants";
import type { ObservationRecordReadType } from "./definitions";
import { convertObservation, enrichObservationWithModelData } from "./observations_converters";
import { getTracesByIds } from "./traces";

export type ObservationTableQuery = {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  limit?: number;
  offset?: number;
  selectIOAndMetadata?: boolean;
  renderingProps?: RenderingProps;
  /**
   * Per-field I/O size cap (events table only): fields whose full length is
   * within `inlineChars` come back whole, larger fields come back as a
   * `previewChars` head plus true lengths and truncation flags. Takes
   * precedence over `renderingProps.truncated` for the I/O select.
   */
  ioSizeCap?: { inlineChars: number; previewChars: number };
  /**
   * Events table only: collapse un-merged ReplacingMergeTree row versions to
   * one row per span (`ORDER BY ..., event_ts DESC` + `LIMIT 1 BY span_id`),
   * so row counts equal distinct observations and the newest version wins.
   * Required by callers whose limits/paging count observations.
   */
  dedupeBySpanId?: boolean;
  clickhouseConfigs?: ClickHouseClientConfigOptions | undefined;
};

export type ObservationsTableQueryResult = ObservationRecordReadType & {
  latency?: string;
  time_to_first_token?: string;
  trace_tags?: string[];
  trace_name?: string;
  trace_user_id?: string;
  // Tool counts for list view performance (ClickHouse numbers as strings)
  tool_definitions_count?: string;
  tool_calls_count?: string;
};

export const getObservationsTableCount = async (opts: ObservationTableQuery) => {
  const count = await getObservationsTableInternal<{
    count: string;
  }>({
    ...opts,
    select: "count",
  });

  return Number(count[0].count);
};

export const getObservationsTableWithModelData = async (
  opts: ObservationTableQuery,
): Promise<FullObservations> => {
  const observationRecords = await getObservationsTableInternal<
    Omit<ObservationsTableQueryResult, "trace_tags" | "trace_name" | "trace_user_id">
  >({
    ...opts,
    select: "rows",
  });

  const uniqueModels: string[] = Array.from(
    new Set(
      observationRecords.map((r) => r.internal_model_id).filter((r): r is string => Boolean(r)),
    ),
  );

  const [models, traces] = await Promise.all([
    uniqueModels.length > 0
      ? prisma.query.models.findMany({
          where: relationalFilter(
            and(
              inArray(modelsTable.id, uniqueModels),
              or(eq(modelsTable.projectId, opts.projectId), isNull(modelsTable.projectId)),
            ),
          ),
          with: { prices: true },
        })
      : [],
    getTracesByIds(
      observationRecords.map((o) => o.trace_id).filter((o): o is string => Boolean(o)),
      opts.projectId,
    ),
  ]);

  return observationRecords.map((o) => {
    const trace = traces.find((t) => t.id === o.trace_id);
    const model = models.find((m) => m.id === o.internal_model_id);
    return {
      ...convertObservation(o),
      latency: o.latency ? Number(o.latency) / 1000 : null,
      timeToFirstToken: o.time_to_first_token ? Number(o.time_to_first_token) / 1000 : null,
      traceName: trace?.name ?? null,
      traceTags: trace?.tags ?? [],
      traceTimestamp: trace?.timestamp ?? null,
      userId: trace?.userId ?? null,
      // Tool counts for list view (actual data in toolDefinitions/toolCalls from domain)
      toolDefinitionsCount: o.tool_definitions_count ? Number(o.tool_definitions_count) : null,
      toolCallsCount: o.tool_calls_count ? Number(o.tool_calls_count) : null,
      ...enrichObservationWithModelData(model),
    };
  });
};

export const getObservationsTableInternal = async <T>(
  opts: ObservationTableQuery & {
    select: "count" | "rows";
  },
): Promise<Array<T>> => {
  const select =
    opts.select === "count"
      ? "count(*) as count"
      : `
        o.id as id,
        o.type as type,
        o.project_id as "project_id",
        o.name as name,
        o."model_parameters" as model_parameters,
        o.start_time as "start_time",
        o.end_time as "end_time",
        o.trace_id as "trace_id",
        o.completion_start_time as "completion_start_time",
        o.provided_usage_details as "provided_usage_details",
        o.usage_details as "usage_details",
        o.provided_cost_details as "provided_cost_details",
        o.cost_details as "cost_details",
        o.level as level,
        o.environment as "environment",
        o.status_message as "status_message",
        o.version as version,
        o.parent_observation_id as "parent_observation_id",
        o.created_at as "created_at",
        o.updated_at as "updated_at",
        o.provided_model_name as "provided_model_name",
        o.total_cost as "total_cost",
        o.usage_pricing_tier_id as "usage_pricing_tier_id",
        o.usage_pricing_tier_name as "usage_pricing_tier_name",
        o.prompt_id as "prompt_id",
        o.prompt_name as "prompt_name",
        o.prompt_version as "prompt_version",
        internal_model_id as "internal_model_id",
        if(isNull(end_time), NULL, date_diff('millisecond', start_time, end_time)) as latency,
        if(isNull(completion_start_time), NULL,  date_diff('millisecond', start_time, completion_start_time)) as "time_to_first_token",
        length(mapKeys(o.tool_definitions)) as "tool_definitions_count",
        length(o.tool_calls) as "tool_calls_count"`;

  const { projectId, filter, selectIOAndMetadata, limit, offset, orderBy, clickhouseConfigs } =
    opts;

  // OTel projects use immutable spans - no need for deduplication
  const skipDedup = await shouldSkipObservationsFinal(projectId);

  const selectString = selectIOAndMetadata ? `${select}, o.input, o.output, o.metadata` : select;

  const timeFilter = filter.find(
    (f) => f.column === "Start Time" && (f.operator === ">=" || f.operator === ">"),
  );

  const scoresFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "scores",
      field: "project_id",
      operator: "=",
      value: projectId,
    }),
  ]);

  const hasScoresFilter = filter.some((f) => f.column.toLowerCase().includes("score"));

  // query optimisation: joining traces onto observations is expensive. Hence, only join if the UI table contains filters on traces.
  const traceTableFilter = filter.filter((f) =>
    observationsTableTraceUiColumnDefinitions.some((c) => matchesUiColumnMapping(c, f.column)),
  );

  const orderByTraces = orderBy
    ? observationsTableTraceUiColumnDefinitions.some((c) =>
        matchesUiColumnMapping(c, orderBy.column),
      )
    : undefined;

  timeFilter
    ? scoresFilter.push(
        new DateTimeFilter({
          clickhouseTable: "scores",
          field: "timestamp",
          operator: ">=",
          value: timeFilter.value as Date,
        }),
      )
    : undefined;

  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedScoresFilter = scoresFilter.apply();
  const appliedObservationsFilter = observationsFilter.apply();

  const search = clickhouseSearchCondition({
    query: opts.searchQuery,
    searchType: opts.searchType,
    tablePrefix: "o",
  });

  const scoresCte = `WITH scores_agg AS (
    SELECT
      trace_id,
      observation_id,
      -- For numeric scores, use tuples of (name, avg_value)
      groupArrayIf(
        tuple(name, avg_value),
        data_type IN ('NUMERIC', 'BOOLEAN')
      ) AS scores_avg,
      -- For categorical scores, use name:value format for improved query performance
      groupArrayIf(
        concat(name, ':', string_value),
        data_type = 'CATEGORICAL' AND notEmpty(string_value)
      ) AS score_categories,
      ${scoreBooleansAggregation()} AS score_booleans
    FROM (
      SELECT
        trace_id,
        observation_id,
        name,
        avg(value) avg_value,
        string_value,
        data_type,
        comment
      FROM
        scores FINAL
      WHERE ${appliedScoresFilter.query}
      GROUP BY
        trace_id,
        observation_id,
        name,
        string_value,
        data_type,
        comment
      ORDER BY
        trace_id
      ) tmp
    GROUP BY
      trace_id,
      observation_id
  )`;

  // if we have default ordering by time, we order by toDate(o.start_time) first and then by
  // o.start_time. This way, clickhouse is able to read more efficiently directly from disk without ordering
  const newDefaultOrder =
    orderBy?.column === "startTime"
      ? [{ column: "order_by_date", order: orderBy.order }, orderBy]
      : [orderBy ?? null];

  const chOrderBy = orderByToClickhouseSql(newDefaultOrder, [
    ...observationsTableUiColumnDefinitions,
    {
      uiTableName: "order_by_date",
      uiTableId: "order_by_date",
      clickhouseTableName: "observation",
      clickhouseSelect: "toDate(o.start_time)",
    },
  ]);

  // joins with traces are very expensive. We need to filter by time as well.
  // We assume that a trace has to have been within the last 2 days to be relevant.

  const query = `
      ${scoresCte}
      SELECT
       ${selectString}
      FROM observations o
        ${traceTableFilter.length > 0 || orderByTraces || search.query ? "LEFT JOIN __TRACE_TABLE__ t FINAL ON t.id = o.trace_id AND t.project_id = o.project_id" : ""}
        ${hasScoresFilter ? `LEFT JOIN scores_agg AS s ON s.trace_id = o.trace_id and s.observation_id = o.id` : ""}
      WHERE ${appliedObservationsFilter.query}

        ${timeFilter && (traceTableFilter.length > 0 || orderByTraces) ? `AND t.timestamp > {tracesTimestampFilter: DateTime64(3)} - ${OBSERVATIONS_TO_TRACE_INTERVAL}` : ""}
        ${search.query}
      ${chOrderBy}
      ${opts.select === "rows" && !skipDedup ? "LIMIT 1 BY o.id, o.project_id" : ""}
      ${limit !== undefined && offset !== undefined ? `LIMIT ${limit} OFFSET ${offset}` : ""};`;

  const input = {
    params: {
      ...appliedScoresFilter.params,
      ...appliedObservationsFilter.params,
      ...(timeFilter
        ? {
            tracesTimestampFilter: convertDateToClickhouseDateTime(timeFilter.value as Date),
          }
        : {}),
      ...search.params,
    },
    tags: { projectId },
  };

  return queryClickhouse<T>({
    query: query.replace("__TRACE_TABLE__", "traces"),
    params: input.params,
    tags: input.tags,
    clickhouseConfigs,
  });
};
