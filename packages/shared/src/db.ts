// This file exports the prisma db connection, the Prisma Object, and the Typescript types.
// This is not imported in the index.ts file of this package, as we must not import this into FE code.

import { resolve } from "node:path";
import { env } from "node:process";
import { type Prisma, PrismaClient } from "@prisma/client";
import { logger } from "./server";
import { isLiteMode } from "./server/adapters";

export class PrismaClientSingleton {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (PrismaClientSingleton.instance) {
      return PrismaClientSingleton.instance;
    }

    PrismaClientSingleton.instance = createPrismaInstance();

    return PrismaClientSingleton.instance;
  }
}

const createPrismaInstance = () => {
  // In lite mode, Prisma uses SQLite via DATABASE_URL=file:./dev.db
  // In full mode, Prisma uses PostgreSQL via DATABASE_URL=postgresql://...
  let datasourceUrl: string | undefined;
  if (isLiteMode()) {
    const raw = env.DATABASE_URL ?? "file:./.langfuse/langfuse.db";
    // Resolve relative file: paths to absolute so Prisma can always find the DB
    // regardless of the process working directory.
    if (raw.startsWith("file:") && !raw.startsWith("file:/")) {
      const relPath = raw.slice("file:".length);
      datasourceUrl = `file:${resolve(process.cwd(), relPath)}`;
    } else {
      datasourceUrl = raw;
    }
  }

  const client = new PrismaClient<Prisma.PrismaClientOptions, "warn" | "error" | "query">({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });

  if (env.NODE_ENV === "development") {
    client.$on("query", (event) => {
      logger.debug(`prisma:query ${event.query}, ${event.duration}ms`);
    });
  }

  client.$on("warn", (event) => {
    logger.warn(`prisma:warn ${event.message}`);
  });

  client.$on("error", (event) => {
    logger.error(`prisma:error ${event.message}`);
  });
  return client;
};

// biome-ignore lint/suspicious/noShadowRestrictedNames: augmenting globalThis for Prisma singleton
declare const globalThis: {
  prismaGlobal: PrismaClient | undefined;
} & typeof global;

// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.NODE_ENV === "development") {
  globalThis.prismaGlobal ??= createPrismaInstance(); // regular instantiation
}

export const prisma = globalThis.prismaGlobal ?? PrismaClientSingleton.getInstance();

export * from "@prisma/client";
// Enum compat: explicit exports override star-export above (SQLite has no enums)
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
} from "./prisma-enums";
