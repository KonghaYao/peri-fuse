/**
 * Filter factory for lite mode.
 * Converts FilterState objects (from the public API `filter` JSON param) into
 * filter instances that liteBuildFilterWhere can iterate over.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { InvalidRequestError } from "../../../errors";
import {
  ArrayOptionsFilter,
  BooleanFilter,
  CategoryOptionsFilter,
  DateTimeFilter,
  NullFilter,
  NumberFilter,
  StringFilter,
  StringOptionsFilter,
} from "./clickhouse-filter";

/** Extract the bare column name from a clickhouseSelect ('o."metadata"' -> 'metadata'). */
function toPlainColumnName(select: string): string {
  const quoted = /"([^"]+)"/.exec(select);
  return quoted ? quoted[1] : select;
}

/**
 * Normalize a user-supplied JSON path key into a SQLite json_extract path
 * ('$.key'), escaping single quotes so it is safe inside a string literal.
 */
function toSqliteJsonPath(key: string): string {
  const trimmed = key.trim();
  const path = trimmed.startsWith("$.")
    ? trimmed.slice(2)
    : trimmed.startsWith("$")
      ? trimmed.slice(1)
      : trimmed;
  const escaped = path.replace(/'/g, "''");
  return escaped.startsWith("[") ? `$${escaped}` : `$.${escaped}`;
}

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

    // Resolve column name to clickhouse mapping. An unmapped column is a
    // filter the lite mode cannot execute — raise an explicit 400 (with the
    // column name) instead of silently dropping the condition and returning
    // unfiltered data.
    const col = columnMapping?.find(
      (m: any) => m.uiTableId === f.column || m.uiTableName === f.column,
    );
    if (!col) {
      throw new InvalidRequestError(
        `Filter column "${String(f.column)}" is not supported in lite mode`,
      );
    }

    const clickhouseTable = col.clickhouseTableName ?? "";
    const field = col.clickhouseSelect ?? f.column;
    const tablePrefix = col.queryPrefix;

    switch (f.type) {
      case "string":
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
      case "stringObject": {
        // Filtering a JSON-object column (e.g. metadata) by key -> SQLite
        // json_extract expression. The bare column name is used so the lite
        // SQL builder's column whitelist can validate the base column; the
        // full expression then acts as the SQL column.
        const fieldExpr = f.key
          ? `json_extract(${toPlainColumnName(field)}, '${toSqliteJsonPath(String(f.key))}')`
          : field;
        results.push(
          new StringFilter({
            clickhouseTable,
            field: fieldExpr,
            operator: f.operator ?? "=",
            value: f.value,
            tablePrefix,
          }),
        );
        break;
      }
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
      case "boolean":
        results.push(
          new BooleanFilter({
            clickhouseTable,
            field,
            operator: f.operator ?? "=",
            value: f.value,
            tablePrefix,
          }),
        );
        break;
      case "null":
        results.push(
          new NullFilter({
            clickhouseTable,
            field,
            operator: f.operator ?? "is null",
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
