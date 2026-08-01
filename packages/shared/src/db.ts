// This file exports the drizzle db connection and the TypeScript types.
// This is not imported in the index.ts file of this package, as we must not import this into FE code.
//
// Migrated from Prisma to Drizzle (better-sqlite3). The `prisma` export is kept
// as an alias of the Drizzle database for a smooth transition; new code should
// prefer `getDb()`. Model types previously re-exported from `@prisma/client` are
// now inferred from the Drizzle schema (see ./types). The `Prisma` namespace
// (sql/raw/join/empty + error + input types) is provided by ./prisma-compat.

import { getDb, closeDb, ensureSchema, type Db } from "./db/client.js";

export { getDb, closeDb, ensureSchema, type Db };

/**
 * Drizzle database instance. Named `prisma` for historical continuity; it is a
 * Drizzle `BetterSQLite3Database`, NOT a PrismaClient. Use Drizzle query APIs
 * (`db.select()…`, `db.query.<table>…`, `db.insert()…`, `db.all(sql`…`)`).
 */
export const prisma = getDb();

// Model row/insert types (User, ApiKey, Project, …) inferred from Drizzle tables.
export * from "./db/types.js";

// `Prisma` namespace replacement (sql builders, error class, loose input types).
export { Prisma, PrismaClientKnownRequestError, toKnownRequestError, type Sql } from "./db/prisma-compat.js";

// Enum compat (SQLite has no enums; string literal unions live in ./prisma-enums).
export {
  ActionExecutionStatus,
  ActionType,
  AnalyticsIntegrationExportSource,
  AnnotationQueueObjectType,
  AnnotationQueueStatus,
  ApiKeyScope,
  AuditLogRecordType,
  BlobStorageExportMode,
  BlobStorageIntegrationFileType,
  BlobStorageIntegrationType,
  CommentObjectType,
  DashboardWidgetChartType,
  DashboardWidgetViews,
  DatasetStatus,
  EvalTemplateSourceCodeLanguage,
  EvalTemplateType,
  EvaluatorBlockReason,
  InAppAgentConversationVisibilityScope,
  JobConfigState,
  JobExecutionStatus,
  JobType,
  MonitorSeverity,
  MonitorStatus,
  MonitorThresholdOperator,
  MonitorView,
  NotificationChannel,
  NotificationType,
  Role,
  ScoreConfigDataType,
  SurveyName,
} from "./prisma-enums.js";
