/**
 * Prisma Enum Compatibility Layer
 *
 * When the Prisma client is generated from the SQLite schema, enums don't exist
 * (they become String fields). This file provides all enum values as plain
 * TypeScript constants so the rest of the codebase works regardless of which
 * schema the client was generated from.
 *
 * Usage: import { JobConfigState, Role } from "./prisma-enums";
 */

// Helper: creates a Prisma-style enum object (keys === values). The return
// type `{ [K in T]: K }` preserves each key's own literal value (rather than
// widening every key to the full union as `Record<T, T>` would) so that
// `z.enum(...)` infers precise literal unions from these objects.
function defineEnum<T extends string>(values: readonly T[]): { [K in T]: K } {
  const obj = {} as { [K in T]: K };
  for (const v of values) {
    obj[v] = v;
  }
  return obj;
}

/**
 * asLiteColumn marks a value for assignment to a column whose type differs
 * between the two Prisma schemas: `Json`/`String[]` in the Postgres schema
 * (`schema.prisma`) but `String` in the SQLite schema (`schema.sqlite.prisma`).
 *
 * It is a type-level no-op: at runtime the value passes through unchanged, so
 * the Postgres client still receives the raw object/array and serializes it.
 * The returned `T & string` is assignable to both the SQLite `string` column
 * type and the Postgres `InputJsonValue`/`string[]` column types.
 *
 * Only use this at call sites that are NOT exercised in lite mode (the lite
 * runtime does not execute these code paths); in lite mode the underlying
 * column is a plain string and would need explicit JSON serialization.
 */
export function asLiteColumn<T>(value: T): T & string {
  return value as T & string;
}

export const ApiKeyScope = defineEnum(["ORGANIZATION", "PROJECT"] as const);
export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

export const InAppAgentConversationVisibilityScope = defineEnum(["PERSONAL", "PROJECT"] as const);
export type InAppAgentConversationVisibilityScope =
  (typeof InAppAgentConversationVisibilityScope)[keyof typeof InAppAgentConversationVisibilityScope];

export const Role = defineEnum(["OWNER", "ADMIN", "MEMBER", "VIEWER", "NONE"] as const);
export type Role = (typeof Role)[keyof typeof Role];

export const ScoreConfigDataType = defineEnum([
  "CATEGORICAL",
  "NUMERIC",
  "BOOLEAN",
  "TEXT",
] as const);
export type ScoreConfigDataType = (typeof ScoreConfigDataType)[keyof typeof ScoreConfigDataType];

export const AnnotationQueueStatus = defineEnum(["PENDING", "COMPLETED"] as const);
export type AnnotationQueueStatus =
  (typeof AnnotationQueueStatus)[keyof typeof AnnotationQueueStatus];

export const AnnotationQueueObjectType = defineEnum(["TRACE", "OBSERVATION", "SESSION"] as const);
export type AnnotationQueueObjectType =
  (typeof AnnotationQueueObjectType)[keyof typeof AnnotationQueueObjectType];

export const DatasetStatus = defineEnum(["ACTIVE", "ARCHIVED"] as const);
export type DatasetStatus = (typeof DatasetStatus)[keyof typeof DatasetStatus];

export const CommentObjectType = defineEnum(["TRACE", "OBSERVATION", "SESSION", "PROMPT"] as const);
export type CommentObjectType = (typeof CommentObjectType)[keyof typeof CommentObjectType];

export const NotificationChannel = defineEnum(["EMAIL"] as const);
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationType = defineEnum(["COMMENT_MENTION"] as const);
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const AuditLogRecordType = defineEnum(["USER", "API_KEY"] as const);
export type AuditLogRecordType = (typeof AuditLogRecordType)[keyof typeof AuditLogRecordType];

export const EvalTemplateType = defineEnum(["LLM_AS_JUDGE", "CODE"] as const);
export type EvalTemplateType = (typeof EvalTemplateType)[keyof typeof EvalTemplateType];

export const EvalTemplateSourceCodeLanguage = defineEnum(["PYTHON", "TYPESCRIPT"] as const);
export type EvalTemplateSourceCodeLanguage =
  (typeof EvalTemplateSourceCodeLanguage)[keyof typeof EvalTemplateSourceCodeLanguage];

export const JobType = defineEnum(["EVAL"] as const);
export type JobType = (typeof JobType)[keyof typeof JobType];

export const JobConfigState = defineEnum(["ACTIVE", "INACTIVE"] as const);
export type JobConfigState = (typeof JobConfigState)[keyof typeof JobConfigState];

export const EvaluatorBlockReason = defineEnum([
  "LLM_CONNECTION_AUTH_INVALID",
  "LLM_CONNECTION_BILLING_EXHAUSTED",
  "LLM_CONNECTION_ENDPOINT_UNREACHABLE",
  "LLM_CONNECTION_MISSING",
  "DEFAULT_EVAL_MODEL_MISSING",
  "EVAL_MODEL_CONFIG_INVALID",
  "EVAL_MODEL_UNAVAILABLE",
  "PROVIDER_ACCOUNT_NOT_READY",
] as const);
export type EvaluatorBlockReason = (typeof EvaluatorBlockReason)[keyof typeof EvaluatorBlockReason];

export const JobExecutionStatus = defineEnum([
  "COMPLETED",
  "ERROR",
  "PENDING",
  "CANCELLED",
  "DELAYED",
] as const);
export type JobExecutionStatus = (typeof JobExecutionStatus)[keyof typeof JobExecutionStatus];

export const DashboardWidgetViews = defineEnum([
  "TRACES",
  "OBSERVATIONS",
  "SCORES_NUMERIC",
  "SCORES_CATEGORICAL",
  "SCORES_BOOLEAN",
] as const);
export type DashboardWidgetViews = (typeof DashboardWidgetViews)[keyof typeof DashboardWidgetViews];

export const DashboardWidgetChartType = defineEnum([
  "LINE_TIME_SERIES",
  "AREA_TIME_SERIES",
  "BAR_TIME_SERIES",
  "HORIZONTAL_BAR",
  "VERTICAL_BAR",
  "PIE",
  "NUMBER",
  "HISTOGRAM",
] as const);
export type DashboardWidgetChartType =
  (typeof DashboardWidgetChartType)[keyof typeof DashboardWidgetChartType];

export const MonitorThresholdOperator = defineEnum([
  "GT",
  "GTE",
  "LT",
  "LTE",
  "EQ",
  "NEQ",
] as const);
export type MonitorThresholdOperator =
  (typeof MonitorThresholdOperator)[keyof typeof MonitorThresholdOperator];

export const MonitorView = defineEnum([
  "OBSERVATIONS",
  "SCORES_NUMERIC",
  "SCORES_CATEGORICAL",
  "SCORES_BOOLEAN",
] as const);
export type MonitorView = (typeof MonitorView)[keyof typeof MonitorView];

export const MonitorSeverity = defineEnum([
  "PAUSED",
  "UNKNOWN",
  "NO_DATA",
  "OK",
  "WARNING",
  "ALERT",
] as const);
export type MonitorSeverity = (typeof MonitorSeverity)[keyof typeof MonitorSeverity];

export const MonitorStatus = defineEnum(["PAUSED", "ACTIVE", "ERROR_BAD_QUERY"] as const);
export type MonitorStatus = (typeof MonitorStatus)[keyof typeof MonitorStatus];

export const BlobStorageIntegrationFileType = defineEnum([
  "JSON",
  "CSV",
  "JSONL",
  "PARQUET",
] as const);
export type BlobStorageIntegrationFileType =
  (typeof BlobStorageIntegrationFileType)[keyof typeof BlobStorageIntegrationFileType];

export const BlobStorageIntegrationType = defineEnum([
  "S3",
  "S3_COMPATIBLE",
  "AZURE_BLOB_STORAGE",
] as const);
export type BlobStorageIntegrationType =
  (typeof BlobStorageIntegrationType)[keyof typeof BlobStorageIntegrationType];

export const BlobStorageExportMode = defineEnum([
  "FULL_HISTORY",
  "FROM_TODAY",
  "FROM_CUSTOM_DATE",
] as const);
export type BlobStorageExportMode =
  (typeof BlobStorageExportMode)[keyof typeof BlobStorageExportMode];

export const AnalyticsIntegrationExportSource = defineEnum([
  "TRACES_OBSERVATIONS",
  "TRACES_OBSERVATIONS_EVENTS",
  "EVENTS",
] as const);
export type AnalyticsIntegrationExportSource =
  (typeof AnalyticsIntegrationExportSource)[keyof typeof AnalyticsIntegrationExportSource];

export const ActionType = defineEnum(["WEBHOOK", "SLACK", "GITHUB_DISPATCH"] as const);
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

export const ActionExecutionStatus = defineEnum([
  "COMPLETED",
  "ERROR",
  "PENDING",
  "CANCELLED",
] as const);
export type ActionExecutionStatus =
  (typeof ActionExecutionStatus)[keyof typeof ActionExecutionStatus];

export const SurveyName = defineEnum(["ORG_ONBOARDING", "USER_ONBOARDING"] as const);
export type SurveyName = (typeof SurveyName)[keyof typeof SurveyName];
