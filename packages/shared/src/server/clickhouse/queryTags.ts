/** Stub: ClickHouse query tags not available in lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function addQueryTags(_tags: Record<string, string>): void {}
export function getQueryTags(): Record<string, string> {
  return {};
}
export type QueryTagContext = any;
export function withQueryTags<T>(fn: () => T): T {
  return fn();
}
