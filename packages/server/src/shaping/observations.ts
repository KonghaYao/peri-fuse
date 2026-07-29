/**
 * Observations filter building + DB→API shaping.
 * Ported from web/src/features/public-api/server/observations.ts and
 * web/src/features/public-api/types/observations.ts (transform only).
 */

import type { FilterState } from "@langfuse-lite/shared";
import {
  type EventsObservation,
  type Observation,
  observationsTableCols,
} from "@langfuse-lite/shared";
import {
  generateObservationsForPublicApi as _generateObservationsForPublicApi,
  getObservationsCountForPublicApi as _getObservationsCountForPublicApi,
  createPublicApiObservationsColumnMapping,
  deriveFilters,
  type ObservationPriceFields,
  observationsTableUiColumnDefinitions,
  reduceUsageOrCostDetails,
  StringFilter,
} from "@langfuse-lite/shared/src/server";

type ObservationsApiQueryProps = {
  page: number;
  limit: number;
  projectId: string;
  traceId?: string;
  userId?: string;
  level?: string;
  name?: string;
  type?: string;
  environment?: string | string[];
  parentObservationId?: string;
  fromStartTime?: string;
  toStartTime?: string;
  version?: string;
  advancedFilters?: FilterState;
};

const publicApiObservationsFilterParams = createPublicApiObservationsColumnMapping(
  "observations",
  "o",
  "parent_observation_id",
);

function buildObservationsFilter(props: ObservationsApiQueryProps) {
  const { advancedFilters, ...simpleFilterProps } = props;
  const chFilter = deriveFilters(
    simpleFilterProps,
    publicApiObservationsFilterParams,
    advancedFilters,
    observationsTableUiColumnDefinitions.filter((c) => c.clickhouseTableName !== "scores"),
    observationsTableCols,
  );

  const filteredChFilter = chFilter.filter((f) => f.clickhouseTable !== "scores");

  filteredChFilter.push(
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: props.projectId,
    }),
  );
  return filteredChFilter;
}

export const generateObservationsForPublicApi = (props: ObservationsApiQueryProps) => {
  const filter = buildObservationsFilter(props);
  return _generateObservationsForPublicApi({
    projectId: props.projectId,
    filter,
    pagination: { limit: props.limit, page: props.page },
  });
};

export const getObservationsCountForPublicApi = (props: ObservationsApiQueryProps) => {
  const filter = buildObservationsFilter(props);
  return _getObservationsCountForPublicApi({
    projectId: props.projectId,
    filter,
  });
};

/**
 * Transforms a DB observation into the public API shape.
 * Ported from web/src/features/public-api/types/observations.ts.
 *
 * @param observation - DB Observation (may include EventsObservation with
 *   userId/sessionId, which are excluded from public API)
 * @returns API Observation as defined in the public API
 */
export const transformDbToApiObservation = (
  observation: (Observation | EventsObservation) & ObservationPriceFields,
) => {
  const reducedUsageDetails = reduceUsageOrCostDetails(observation.usageDetails);
  const reducedCostDetails = reduceUsageOrCostDetails(observation.costDetails);

  const unit = "TOKENS";

  const promptTokens = reducedUsageDetails.input ?? 0;
  const completionTokens = reducedUsageDetails.output ?? 0;
  const totalTokens = reducedUsageDetails.total ?? 0;

  const {
    providedUsageDetails,
    providedCostDetails,

    internalModelId,

    inputCost,

    outputCost,

    totalCost,

    inputUsage,

    outputUsage,

    totalUsage,
    // Exclude userId and sessionId from public API (security/privacy)

    userId,

    sessionId,

    // exclude trace name, this will only be available on events api
    traceName,

    // exclude release, this will only be available on events api
    release,

    // Exclude tags
    tags,
    traceTags,

    // Exclude tool data from public API (not yet released)

    toolDefinitions,

    toolCalls,

    toolCallNames,

    // Exclude publish/bookmark flags from V1 public observations API.
    // V2 observations already exposes these on the events-based contract.
    bookmarked,

    public: _public,
    ...rest
  } = observation as EventsObservation &
    ObservationPriceFields & {
      // The `tags` field is sometimes renamed to `traceTags` depending on context.
      // Since `transformDbToApiObservation` is called from multiple sources,
      // either `tags` or `traceTags` may exist on the input observation.
      // This is not part of the standard `EventsObservation` type.
      traceTags?: string[];
    };

  return {
    ...rest,
    calculatedInputCost: reducedCostDetails.input,
    calculatedOutputCost: reducedCostDetails.output,
    calculatedTotalCost: reducedCostDetails.total,
    unit: unit,
    inputPrice: observation.inputPrice?.toNumber() ?? null,
    outputPrice: observation.outputPrice?.toNumber() ?? null,
    totalPrice: observation.totalPrice?.toNumber() ?? null,
    promptTokens,
    completionTokens,
    totalTokens,
    modelId: observation.internalModelId ?? null,
    usage: {
      unit,
      input: promptTokens,
      output: completionTokens,
      total: totalTokens,
    },
  };
};
