/** Stub: ClickHouse repository helpers not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function queryClickhouse<T = any>(
  _opts: any,
  _service?: any,
  _opts2?: any,
): Promise<T[]> {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function commandClickhouse(_opts: any): Promise<void> {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function upsertClickhouse(_opts: any): Promise<void> {
  throw new Error("ClickHouse is not available in lite mode");
}
export function queryClickhouseStream<_T = any>(_opts: any): any {
  throw new Error("ClickHouse is not available in lite mode");
}
export function queryClickhouseStreamRawText(_opts: any): any {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function queryClickhouseExecRaw(_opts: any): Promise<any> {
  throw new Error("ClickHouse is not available in lite mode");
}
export function parseClickhouseUTCDateTimeFormat(value: string): Date {
  return new Date(value);
}
export function clickhouseCompliantRandomCharacters(_length?: number): string {
  return Math.random().toString(36).substring(2);
}
export const BLOB_EXPORT_PARQUET_CLICKHOUSE_SETTINGS: any = {};
export type PreferredClickhouseService = any;
export const PreferredClickhouseService = { READ: "read", WRITE: "write" } as any;
