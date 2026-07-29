/** Stub: ClickHouse client not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ClickHouseClientType = any;
export type PreferredClickhouseService = any;
export const PreferredClickhouseService = { READ: "read", WRITE: "write" } as any;
export function clickhouseClient(): never {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function queryClickhouse<T = any>(_opts: any): Promise<T[]> {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function commandClickhouse(_opts: any): Promise<void> {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function upsertClickhouse(_opts: any): Promise<void> {
  throw new Error("ClickHouse is not available in lite mode");
}
export async function deleteClickhouse(_opts: any): Promise<void> {
  throw new Error("ClickHouse is not available in lite mode");
}
export function parseClickhouseUTCDateTimeFormat(value: string): Date {
  return new Date(value);
}
export function convertDateToClickhouseDateTime(date: Date): string {
  return date.toISOString();
}
