/** Stub: Queries barrel export for lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export * from "./clickhouse-sql/clickhouse-filter";
export * from "./clickhouse-sql/factory";
export * from "./clickhouse-sql/query-fragments";
export * from "./clickhouse-sql/query-options";
export * from "./clickhouse-sql/search";
export * from "./types";

// Additional stubs for repository imports
export type FullObservations = any;
export function orderByToClickhouseSql(_orderBy: any, _table?: any): string {
  return "";
}
export class CTEQueryBuilder {
  withCTE(_name: string, _query: any): CTEQueryBuilder {
    return this;
  }
  from(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  select(..._cols: any[]): CTEQueryBuilder {
    return this;
  }
  where(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  orderBy(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  limit(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  offset(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  join(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  leftJoin(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  groupBy(..._args: any[]): CTEQueryBuilder {
    return this;
  }
  build(): any {
    return { query: "", params: [] };
  }
  buildWithParams(): any {
    return { query: "", params: [] };
  }
}
