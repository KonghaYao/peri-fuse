/**
 * Filter factory for lite mode.
 * Converts FilterState objects (from the public API `filter` JSON param) into
 * filter instances that liteBuildFilterWhere can iterate over.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ArrayOptionsFilter,
  CategoryOptionsFilter,
  DateTimeFilter,
  NumberFilter,
  StringFilter,
  StringOptionsFilter,
} from "./clickhouse-filter";

export function createQuery(_opts: any): { query: string; params: any[] } {
  return { query: "", params: [] };
}
export function getProjectIdDefaultFilter(_projectId: string, _opts?: any): any {
  return {};
}
export type QueryBuilder = any;

/**
 * Convert an array of FilterState conditions into filter instances.
 * Uses uiColumnDefinitions to resolve column names to clickhouse table/field.
 */
export function createFilterFromFilterState(
  filter: any[],
  columnMapping: readonly any[],
  _columnDefinitions?: readonly any[],
): any[] {
  if (!filter || filter.length === 0) return [];

  const results: any[] = [];

  for (const f of filter) {
    if (!f?.column || !f.type) continue;

    // Resolve column name to clickhouse mapping
    const col = columnMapping?.find(
      (m: any) => m.uiTableId === f.column || m.uiTableName === f.column,
    );
    if (!col) continue;

    const clickhouseTable = col.clickhouseTableName ?? "";
    const field = col.clickhouseSelect ?? f.column;
    const tablePrefix = col.queryPrefix;

    switch (f.type) {
      case "string":
      case "stringObject":
        results.push(
          new StringFilter({
            clickhouseTable,
            field,
            operator: f.operator ?? "=",
            value: f.value,
            tablePrefix,
          }),
        );
        break;
      case "datetime":
        results.push(
          new DateTimeFilter({
            clickhouseTable,
            field,
            operator: f.operator ?? ">=",
            value: f.value instanceof Date ? f.value : new Date(f.value),
            tablePrefix,
          }),
        );
        break;
      case "stringOptions":
      case "categoryOptions":
        if (f.type === "categoryOptions" && f.key) {
          results.push(
            new CategoryOptionsFilter({
              clickhouseTable,
              field,
              operator: f.operator ?? "any of",
              values: Array.isArray(f.value) ? f.value : [f.value],
              key: f.key,
              tablePrefix,
            }),
          );
        } else {
          results.push(
            new StringOptionsFilter({
              clickhouseTable,
              field,
              operator: f.operator ?? "any of",
              values: Array.isArray(f.value) ? f.value : [f.value],
              tablePrefix,
            }),
          );
        }
        break;
      case "arrayOptions":
        results.push(
          new ArrayOptionsFilter({
            clickhouseTable,
            field,
            operator: f.operator ?? "all of",
            values: Array.isArray(f.value) ? f.value : [f.value],
            tablePrefix,
          }),
        );
        break;
      case "number":
      case "numberObject":
        results.push(
          new NumberFilter({
            clickhouseTable,
            field,
            operator: f.operator ?? "=",
            value: Number(f.value),
            tablePrefix,
          }),
        );
        break;
      default:
        // Unknown filter type - try as string filter
        if (f.value != null) {
          results.push(
            new StringFilter({
              clickhouseTable,
              field,
              operator: f.operator ?? "=",
              value: String(f.value),
              tablePrefix,
            }),
          );
        }
    }
  }

  return results;
}
