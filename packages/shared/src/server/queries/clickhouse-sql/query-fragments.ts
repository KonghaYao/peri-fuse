/** Stub */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function projectIdFilter(projectId: string): string {
  return `project_id = '${projectId}'`;
}
export function timeFilter(_opts: any): string {
  return "1=1";
}
export function environmentFilter(_env: any): string {
  return "1=1";
}
export function scoreBooleansAggregation(_opts?: any): string {
  return "";
}
export const eventsTraceMetadata: any = {};
export const eventsExperimentTraceIds: any = {};
export const eventsExperiments: any = {};
export const promptEventsForMetrics: any = {};
