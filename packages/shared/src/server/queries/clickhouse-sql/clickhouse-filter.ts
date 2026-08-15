/**
 * Lightweight filter classes for lite mode.
 * These store constructor options as accessible properties so that
 * liteBuildFilterWhere can read .field, .operator, .clickhouseTable, .value, .values.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ClickhouseFilter = { query: string; params: Record<string, any> };
export type ClickhouseOperator = string;

export interface AppliedFilter {
  query: string;
  params: Record<string, any>;
}

export class FilterList {
  private items: any[];
  constructor(filters?: any[]) {
    this.items = filters ?? [];
  }
  get length(): number {
    return this.items.length;
  }
  /** @deprecated use .length property */
  lengthFn(): number {
    return this.items.length;
  }
  add(...f: any[]): void {
    this.items.push(...f);
  }
  push(...f: any[]): void {
    this.items.push(...f);
  }
  toSql(): string {
    return "1=1";
  }
  apply(_ctx?: any): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  forEach(fn: (item: any, index: number) => void): void {
    this.items.forEach(fn);
  }
  find(fn: (item: any) => boolean): any {
    return this.items.find(fn);
  }
  filter(fn: (item: any) => boolean): FilterList {
    return new FilterList(this.items.filter(fn));
  }
  some(fn: (item: any) => boolean): boolean {
    return this.items.some(fn);
  }
  every(fn: (item: any) => boolean): boolean {
    return this.items.every(fn);
  }
  map(fn: (item: any) => any): FilterList {
    return new FilterList(this.items.map(fn));
  }
  [Symbol.iterator](): Iterator<any> {
    return this.items[Symbol.iterator]();
  }
}

interface FilterOpts {
  clickhouseTable?: string;
  field?: string;
  operator?: string;
  value?: any;
  values?: any[];
  tablePrefix?: string;
  key?: string;
  clickhouseTypeOverwrite?: string;
}

export class DateTimeFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  value: any;
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? ">=";
    this.value = opts?.value;
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class StringFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  value: any;
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "=";
    this.value = opts?.value;
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class StringOptionsFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  values: any[];
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "any of";
    this.values = opts?.values ?? [];
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class NumberFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  value: any;
  tablePrefix?: string;
  clickhouseTypeOverwrite?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "=";
    this.value = opts?.value;
    this.tablePrefix = opts?.tablePrefix;
    this.clickhouseTypeOverwrite = opts?.clickhouseTypeOverwrite;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class ArrayOptionsFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  values: any[];
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "all of";
    this.values = opts?.values ?? [];
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class CategoryOptionsFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  values: any[];
  key: string;
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "any of";
    this.values = opts?.values ?? [];
    this.key = opts?.key ?? "";
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class BooleanFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  value: any;
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "=";
    this.value = opts?.value;
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export class NullFilter {
  clickhouseTable: string;
  field: string;
  operator: string;
  tablePrefix?: string;
  constructor(opts?: FilterOpts) {
    this.clickhouseTable = opts?.clickhouseTable ?? "";
    this.field = opts?.field ?? "";
    this.operator = opts?.operator ?? "is null";
    this.tablePrefix = opts?.tablePrefix;
  }
  apply(): AppliedFilter {
    return { query: "1=1", params: {} };
  }
  toSql(): string {
    return "1=1";
  }
}

export function buildClickhouseFilter(_filter: any): string {
  return "1=1";
}
