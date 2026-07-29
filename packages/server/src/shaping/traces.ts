/**
 * Traces filter building.
 * Ported verbatim from web/src/features/public-api/server/traces.ts —
 * all primitives come from @peri-fuse/shared.
 */

import type { FilterState, OrderByState } from "@peri-fuse/shared";
import { tracesTableCols } from "@peri-fuse/shared";
import {
  generateTracesForPublicApi as _generateTracesForPublicApi,
  getTracesCountForPublicApi as _getTracesCountForPublicApi,
  createPublicApiTracesColumnMapping,
  deriveFilters,
  type TraceQueryType,
  tracesTableUiColumnDefinitions,
} from "@peri-fuse/shared/src/server";

const publicApiTracesFilterParams = createPublicApiTracesColumnMapping("traces", "t");

export const generateTracesForPublicApi = ({
  props,
  advancedFilters,
  orderBy,
}: {
  props: TraceQueryType;
  advancedFilters?: FilterState;
  orderBy: OrderByState;
}) => {
  const filter = deriveFilters(
    props,
    publicApiTracesFilterParams,
    advancedFilters,
    tracesTableUiColumnDefinitions,
    tracesTableCols,
  );
  return _generateTracesForPublicApi({
    projectId: props.projectId,
    filter,
    orderBy,
    pagination: { limit: props.limit, page: props.page },
    fields: props.fields,
  });
};

export const getTracesCountForPublicApi = ({
  props,
  advancedFilters,
}: {
  props: TraceQueryType;
  advancedFilters?: FilterState;
}) => {
  const filter = deriveFilters(
    props,
    publicApiTracesFilterParams,
    advancedFilters,
    tracesTableUiColumnDefinitions,
    tracesTableCols,
  );
  return _getTracesCountForPublicApi({
    projectId: props.projectId,
    filter,
    pagination: { limit: props.limit, page: props.page },
  });
};
