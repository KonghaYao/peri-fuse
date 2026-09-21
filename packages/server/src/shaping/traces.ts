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
  liteGetTracesTable,
  type TraceQueryType,
  tracesTableUiColumnDefinitions,
} from "@peri-fuse/shared/src/server";

import { isLiteMode } from "@peri-fuse/shared/src/server/adapters";
import { parseJsonValue } from "./trace-metrics";

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
  if (isLiteMode()) {
    return liteGetTracesTable({
      projectId: props.projectId,
      filter,
      orderBy,
      limit: props.limit,
      page: (props.page ?? 1) - 1,
      includeIO: props.fields === undefined || props.fields.includes("io"),
    }).then((rows) =>
      rows.map((row) => ({
        ...row,
        input: parseJsonValue(row.input),
        output: parseJsonValue(row.output),
        createdAt: row.timestamp,
        updatedAt: row.timestamp,
        htmlPath: `/project/${props.projectId}/traces/${row.id}`,
        observations: [],
        scores: [],
        totalCost: 0,
        latency: 0,
      })),
    );
  }
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
