/**
 * Scores filter building + API shaping (v1 semantics).
 * Ported from web/src/features/public-api/server/scores-api-service.ts
 * (GET path only) and web/src/features/public-api/server/scores.ts.
 */
import {
  LISTABLE_SCORE_TYPES,
  removeObjectKeys,
  ScoreDataTypeEnum,
  type ScoreDataTypeType,
  type ScoreDomain,
  scoresTableCols,
} from "@peri-fuse/shared";
import {
  _handleGenerateScoresForPublicApi,
  _handleGetScoresCountForPublicApi,
  convertApiProvidedFilterToClickhouseFilter,
  deriveFilters,
  type FilterList,
  type ScoreQueryType,
  StringFilter,
  StringOptionsFilter,
  scoresTableUiColumnDefinitions,
} from "@peri-fuse/shared/src/server";

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

function buildScoreFilters(
  props: ScoreQueryType,
  scoreDataTypes?: readonly ScoreDataTypeType[],
): { scoresFilter: FilterList; tracesFilter: FilterList } {
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

  if (scoreDataTypes) {
    scoresFilter.push(
      new StringOptionsFilter({
        clickhouseTable: "scores",
        field: "data_type",
        operator: "any of",
        values: [...scoreDataTypes],
        tablePrefix: "s",
      }),
    );
  }

  const tracesFilter = convertApiProvidedFilterToClickhouseFilter(props, secureTraceFilterOptions);

  if (props.environment && tracesFilter.length > 0) {
    const envValues = Array.isArray(props.environment) ? props.environment : [props.environment];
    tracesFilter.push(
      new StringOptionsFilter({
        clickhouseTable: "traces",
        field: "environment",
        operator: "any of",
        values: envValues,
        tablePrefix: "t",
      }),
    );
  }

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

type ScoreApiResult = Omit<ScoreDomain, "longStringValue"> & {
  stringValue?: string | null;
};
type TextScoreApiResult = Omit<ScoreDomain, "longStringValue" | "value"> & {
  stringValue?: string | null;
};

/**
 * Converts a ScoreDomain object to API format.
 * For CORRECTION scores, moves longStringValue to stringValue for API compatibility.
 * For TEXT scores, removes longStringValue and value (always 0, not meaningful).
 * For other score types, removes longStringValue.
 */
export function convertScoreToPublicApi(
  score: ScoreDomain & { dataType: "TEXT" },
): TextScoreApiResult;
export function convertScoreToPublicApi(score: ScoreDomain): ScoreApiResult;
export function convertScoreToPublicApi(score: ScoreDomain): ScoreApiResult | TextScoreApiResult {
  if (score.dataType === ScoreDataTypeEnum.CORRECTION) {
    const { longStringValue, ...rest } = score;
    return {
      ...rest,
      stringValue: longStringValue,
    };
  }

  if (score.dataType === ScoreDataTypeEnum.TEXT) {
    return removeObjectKeys(score, ["longStringValue", "value"]);
  }

  return removeObjectKeys(score, ["longStringValue"]);
}

/**
 * Get list of scores (v1 semantics: listable score types, traces only).
 */
export async function generateScoresForPublicApi(props: ScoreQueryType) {
  const scoreDataTypes = LISTABLE_SCORE_TYPES;
  const { scoresFilter, tracesFilter } = buildScoreFilters(props, scoreDataTypes);
  const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
    props.fields,
    tracesFilter.length,
  );
  const results = await _handleGenerateScoresForPublicApi({
    projectId: props.projectId,
    scoresFilter,
    tracesFilter,
    scoreScope: "traces_only",
    includeTrace,
    needsTraceJoin,
    pagination: { limit: props.limit, page: props.page },
    apiVersion: "v1",
  });
  // Apply API-shape transformation (moves longStringValue→stringValue for
  // CORRECTION, strips longStringValue for others).
  return results.map(({ trace, ...rest }) => ({
    ...convertScoreToPublicApi(rest),
    trace,
  }));
}

/**
 * Get count of scores (v1 semantics: listable score types, traces only).
 */
export async function getScoresCountForPublicApi(props: ScoreQueryType) {
  const scoreDataTypes = LISTABLE_SCORE_TYPES;
  const { scoresFilter, tracesFilter } = buildScoreFilters(props, scoreDataTypes);
  const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
    props.fields,
    tracesFilter.length,
  );
  return _handleGetScoresCountForPublicApi({
    projectId: props.projectId,
    scoresFilter,
    tracesFilter,
    scoreScope: "traces_only",
    includeTrace,
    needsTraceJoin,
    apiVersion: "v1",
  });
}
