/**
 * Public API filter builder for lite mode.
 * Implements deriveFilters / convertApiProvidedFilterToClickhouseFilter
 * so that the public API endpoints can build FilterList instances that
 * liteBuildFilterWhere can iterate over.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ArrayOptionsFilter,
  DateTimeFilter,
  FilterList,
  NumberFilter,
  StringFilter,
  StringOptionsFilter,
} from "./clickhouse-sql/clickhouse-filter";
import { createFilterFromFilterState } from "./clickhouse-sql/factory";

export type ApiColumnMapping = {
  id: string;
  clickhouseSelect: string;
  clickhouseTable: string;
  filterType: string;
  operator?: string;
  clickhousePrefix?: string;
};

type BaseQueryType = {
  page: number;
  limit: number;
  projectId: string;
} & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Column mapping factories
// ---------------------------------------------------------------------------

const TRACES_COLUMN_DEFINITIONS: {
  id: string;
  column: string;
  filterType: string;
  operator?: string;
}[] = [
  { id: "timestamp", column: "timestamp", filterType: "DateTimeFilter" },
  // Search-box fields use substring matching (the UI commits free text);
  // id-like fields stay exact.
  { id: "userId", column: "user_id", filterType: "StringFilter", operator: "contains" },
  { id: "name", column: "name", filterType: "StringFilter", operator: "contains" },
  { id: "environment", column: "environment", filterType: "StringFilter", operator: "contains" },
  { id: "sessionId", column: "session_id", filterType: "StringFilter" },
  { id: "version", column: "version", filterType: "StringFilter" },
  { id: "release", column: "release", filterType: "StringFilter" },
  { id: "tags", column: "tags", filterType: "ArrayOptionsFilter" },
];

export function createPublicApiTracesColumnMapping(
  tableName: "traces",
  tablePrefix: "t",
): ApiColumnMapping[] {
  const simpleFilters: ApiColumnMapping[] = [];
  for (const def of TRACES_COLUMN_DEFINITIONS) {
    if (def.id === "timestamp") {
      simpleFilters.push(
        {
          id: "fromTimestamp",
          clickhouseSelect: "timestamp",
          operator: ">=",
          filterType: def.filterType,
          clickhouseTable: tableName,
          clickhousePrefix: tablePrefix,
        },
        {
          id: "toTimestamp",
          clickhouseSelect: "timestamp",
          operator: "<",
          filterType: def.filterType,
          clickhouseTable: tableName,
          clickhousePrefix: tablePrefix,
        },
      );
    } else {
      simpleFilters.push({
        id: def.id,
        clickhouseSelect: def.column,
        filterType: def.filterType,
        clickhouseTable: tableName,
        clickhousePrefix: tablePrefix,
        ...(def.operator ? { operator: def.operator } : {}),
      });
    }
  }
  return simpleFilters;
}

export function createPublicApiObservationsColumnMapping(
  tableName: "events_proto" | "observations",
  tablePrefix: "e" | "o",
  parentFieldName: "parent_span_id" | "parent_observation_id",
): ApiColumnMapping[] {
  const userIdMapping: ApiColumnMapping =
    tableName === "events_proto"
      ? {
          id: "userId",
          clickhouseSelect: "user_id",
          filterType: "StringFilter",
          clickhouseTable: tableName,
          clickhousePrefix: tablePrefix,
        }
      : {
          id: "userId",
          clickhouseSelect: "user_id",
          filterType: "StringFilter",
          clickhouseTable: "traces",
          clickhousePrefix: "t",
        };
  return [
    userIdMapping,
    {
      id: "traceId",
      clickhouseSelect: "trace_id",
      filterType: "StringFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "name",
      clickhouseSelect: "name",
      filterType: "StringFilter",
      operator: "contains",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "level",
      clickhouseSelect: "level",
      filterType: "StringFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "type",
      clickhouseSelect: "type",
      filterType: "StringFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "parentObservationId",
      clickhouseSelect: parentFieldName,
      filterType: "StringFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "fromStartTime",
      clickhouseSelect: "start_time",
      operator: ">=",
      filterType: "DateTimeFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "toStartTime",
      clickhouseSelect: "start_time",
      operator: "<",
      filterType: "DateTimeFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "version",
      clickhouseSelect: "version",
      filterType: "StringFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
    {
      id: "environment",
      clickhouseSelect: "environment",
      filterType: "StringOptionsFilter",
      clickhouseTable: tableName,
      clickhousePrefix: tablePrefix,
    },
  ];
}

// ---------------------------------------------------------------------------
// convertApiProvidedFilterToClickhouseFilter
// ---------------------------------------------------------------------------

export function convertApiProvidedFilterToClickhouseFilter(
  filter: BaseQueryType,
  columnMapping: ApiColumnMapping[],
): FilterList {
  const filterList = new FilterList();

  columnMapping.forEach((mapping) => {
    const value = filter[mapping.id as keyof BaseQueryType];
    if (value === undefined || value === null || value === "") return;

    let filterInstance: any;
    switch (mapping.filterType) {
      case "DateTimeFilter": {
        const op = mapping.operator;
        if (op && typeof value === "string" && ["<", "<=", ">", ">="].includes(op)) {
          filterInstance = new DateTimeFilter({
            clickhouseTable: mapping.clickhouseTable,
            field: mapping.clickhouseSelect,
            operator: op,
            value: new Date(value),
            tablePrefix: mapping.clickhousePrefix,
          });
        }
        break;
      }
      case "ArrayOptionsFilter":
        if (Array.isArray(value) || typeof value === "string") {
          filterInstance = new ArrayOptionsFilter({
            clickhouseTable: mapping.clickhouseTable,
            field: mapping.clickhouseSelect,
            operator: "all of",
            values: Array.isArray(value) ? value : String(value).split(","),
            tablePrefix: mapping.clickhousePrefix,
          });
        }
        break;
      case "StringOptionsFilter":
        if (Array.isArray(value) || typeof value === "string") {
          filterInstance = new StringOptionsFilter({
            clickhouseTable: mapping.clickhouseTable,
            field: mapping.clickhouseSelect,
            operator: "any of",
            values: Array.isArray(value) ? value : String(value).split(","),
            tablePrefix: mapping.clickhousePrefix,
          });
        }
        break;
      case "StringFilter":
        if (typeof value === "string") {
          filterInstance = new StringFilter({
            clickhouseTable: mapping.clickhouseTable,
            field: mapping.clickhouseSelect,
            operator: mapping.operator ?? "=",
            value,
            tablePrefix: mapping.clickhousePrefix,
          });
        }
        break;
      case "NumberFilter": {
        const op = (filter as any).operator;
        const validOps = ["=", ">", "<", ">=", "<=", "!="];
        if (op && validOps.includes(op)) {
          filterInstance = new NumberFilter({
            clickhouseTable: mapping.clickhouseTable,
            field: mapping.clickhouseSelect,
            operator: op,
            value: Number(value),
            tablePrefix: mapping.clickhousePrefix,
          });
        }
        break;
      }
    }

    if (filterInstance) filterList.push(filterInstance);
  });

  return filterList;
}

// ---------------------------------------------------------------------------
// deriveFilters
// ---------------------------------------------------------------------------

export function deriveFilters<T extends BaseQueryType>(
  simpleFilterProps: T,
  filterParamsMapping: ApiColumnMapping[],
  advancedFilters: any[] | undefined,
  uiColumnDefinitions: any,
  columnDefinitions?: any[],
): FilterList {
  // Start with advanced filters converted to FilterList
  const filterList = new FilterList(
    createFilterFromFilterState(advancedFilters ?? [], uiColumnDefinitions, columnDefinitions),
  );

  // Convert simple parameters to filters
  const simpleFilters = convertApiProvidedFilterToClickhouseFilter(
    simpleFilterProps,
    filterParamsMapping,
  );

  // Advanced filter takes precedence: skip simple filters on the same field
  const advancedFilterColumns = new Set<string>();
  filterList.forEach((f: any) => advancedFilterColumns.add(f.field));

  simpleFilters
    .filter((sf: any) => !advancedFilterColumns.has(sf.field))
    .forEach((f: any) => filterList.push(f));

  return filterList;
}

export function buildPublicApiFilter(_opts: any): any {
  return new FilterList();
}
