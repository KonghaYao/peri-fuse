/**
 * Drizzle schema for the PeriGateway database (gateway.turso.db).
 *
 * Migrated from prisma/schema.prisma. Table and column names are preserved
 * exactly (PascalCase tables, camelCase columns) so existing data and raw SQL
 * keep working. Timestamps are stored as ISO-8601 text (Prisma-compatible).
 */
import { defineRelations } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ISO-8601 timestamp helpers (Prisma stores DateTime as ISO text in SQLite).
const nowIso = () => new Date().toISOString();

// ═══════════════════════════════════════════
// 凭证 & Provider
// ═══════════════════════════════════════════

export const credential = sqliteTable(
  "credential",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    name: text("name").notNull(),
    values: text("values").notNull(),
    info: text("info"),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
    updatedAt: text("updatedAt").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [
    uniqueIndex("Credential_projectId_name_key").on(t.projectId, t.name),
    index("Credential_projectId_idx").on(t.projectId),
  ],
);

export const provider = sqliteTable(
  "provider",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    credentialId: text("credentialId"),
    baseUrl: text("baseUrl").notNull(),
    apiKeyEncrypted: text("apiKeyEncrypted"),
    isEnabled: integer("isEnabled", { mode: "boolean" }).notNull().default(true),
    budgetLimit: real("budgetLimit"),
    budgetPeriod: text("budgetPeriod"),
    budgetSpend: real("budgetSpend").notNull().default(0),
    budgetResetAt: text("budgetResetAt"),
    status: text("status").notNull().default("healthy"),
    cooldownUntil: text("cooldownUntil"),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
    updatedAt: text("updatedAt").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [
    uniqueIndex("Provider_projectId_name_key").on(t.projectId, t.name),
    index("Provider_projectId_idx").on(t.projectId),
  ],
);

export const modelDeployment = sqliteTable(
  "modeldeployment",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    modelName: text("modelName").notNull(),
    providerId: text("providerId")
      .notNull()
      .references(() => provider.id),
    providerModel: text("providerModel").notNull(),
    litellmParams: text("litellmParams").notNull().default("{}"),
    modelInfo: text("modelInfo"),
    isEnabled: integer("isEnabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
    updatedAt: text("updatedAt").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [
    index("ModelDeployment_modelName_isEnabled_idx").on(t.modelName, t.isEnabled),
    index("ModelDeployment_projectId_idx").on(t.projectId),
  ],
);

// ═══════════════════════════════════════════
// 预算
// ═══════════════════════════════════════════

export const budget = sqliteTable(
  "budget",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    maxBudget: real("maxBudget"),
    softBudget: real("softBudget"),
    maxParallel: integer("maxParallel"),
    tpmLimit: integer("tpmLimit"),
    rpmLimit: integer("rpmLimit"),
    duration: text("duration"),
    resetAt: text("resetAt"),
    modelMaxBudget: text("modelMaxBudget"),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
    updatedAt: text("updatedAt").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [index("Budget_projectId_idx").on(t.projectId)],
);

// ═══════════════════════════════════════════
// API Key 配置
// ═══════════════════════════════════════════

export const apiKey = sqliteTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    publicKey: text("publicKey").notNull().unique(),
    keyName: text("keyName"),
    spend: real("spend").notNull().default(0),
    models: text("models").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    maxParallel: integer("maxParallel"),
    tpmLimit: integer("tpmLimit"),
    rpmLimit: integer("rpmLimit"),
    maxBudget: real("maxBudget"),
    budgetId: text("budgetId").references(() => budget.id),
    isEnabled: integer("isEnabled", { mode: "boolean" }).notNull().default(true),
    lastActive: text("lastActive"),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
    updatedAt: text("updatedAt").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [
    index("ApiKey_publicKey_idx").on(t.publicKey),
    index("ApiKey_projectId_idx").on(t.projectId),
  ],
);

// ═══════════════════════════════════════════
// 日志
// ═══════════════════════════════════════════

export const spendLog = sqliteTable(
  "spendlog",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull().default(""),
    callType: text("callType").notNull(),
    apiKey: text("apiKey").notNull().default(""),
    spend: real("spend").notNull().default(0),
    totalTokens: integer("totalTokens").notNull().default(0),
    promptTokens: integer("promptTokens").notNull().default(0),
    completionTokens: integer("completionTokens").notNull().default(0),
    startTime: text("startTime").notNull(),
    endTime: text("endTime").notNull(),
    completionStartTime: text("completionStartTime"),
    requestDurationMs: integer("requestDurationMs"),
    model: text("model").notNull().default(""),
    modelId: text("modelId"),
    modelGroup: text("modelGroup"),
    provider: text("provider"),
    apiBase: text("apiBase"),
    protocol: text("protocol"),
    user: text("user"),
    metadata: text("metadata").notNull().default("{}"),
    requestTags: text("requestTags").notNull().default("[]"),
    sessionId: text("sessionId"),
    status: text("status"),
    messages: text("messages"),
    response: text("response"),
    errorMessage: text("errorMessage"),
    traceId: text("traceId"),
  },
  (t) => [
    index("SpendLog_startTime_idx").on(t.startTime),
    index("SpendLog_apiKey_startTime_idx").on(t.apiKey, t.startTime),
    index("SpendLog_model_startTime_idx").on(t.model, t.startTime),
    index("SpendLog_sessionId_idx").on(t.sessionId),
    index("SpendLog_projectId_idx").on(t.projectId),
  ],
);

export const errorLog = sqliteTable(
  "errorlog",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull().default(""),
    startTime: text("startTime").notNull(),
    endTime: text("endTime").notNull(),
    apiBase: text("apiBase").notNull().default(""),
    modelGroup: text("modelGroup").notNull().default(""),
    providerModel: text("providerModel").notNull().default(""),
    modelId: text("modelId").notNull().default(""),
    requestKwargs: text("requestKwargs").notNull().default("{}"),
    exceptionType: text("exceptionType").notNull().default(""),
    exceptionString: text("exceptionString").notNull().default(""),
    statusCode: text("statusCode").notNull().default(""),
  },
  (t) => [
    index("ErrorLog_startTime_idx").on(t.startTime),
    index("ErrorLog_projectId_idx").on(t.projectId),
  ],
);

// ═══════════════════════════════════════════
// 用量聚合
// ═══════════════════════════════════════════

export const dailySpend = sqliteTable(
  "dailyspend",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull().default(""),
    apiKey: text("apiKey").notNull(),
    date: text("date").notNull(),
    model: text("model"),
    modelGroup: text("modelGroup"),
    provider: text("provider"),
    promptTokens: integer("promptTokens").notNull().default(0),
    completionTokens: integer("completionTokens").notNull().default(0),
    spend: real("spend").notNull().default(0),
    apiRequests: integer("apiRequests").notNull().default(0),
    successfulRequests: integer("successfulRequests").notNull().default(0),
    failedRequests: integer("failedRequests").notNull().default(0),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
    updatedAt: text("updatedAt").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [
    uniqueIndex("DailySpend_projectId_apiKey_date_model_provider_key").on(
      t.projectId,
      t.apiKey,
      t.date,
      t.model,
      t.provider,
    ),
    index("DailySpend_date_idx").on(t.date),
    index("DailySpend_apiKey_date_idx").on(t.apiKey, t.date),
    index("DailySpend_model_idx").on(t.model),
    index("DailySpend_projectId_idx").on(t.projectId),
  ],
);

// ═══════════════════════════════════════════
// 审计
// ═══════════════════════════════════════════

export const auditLog = sqliteTable(
  "auditlog",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull().default(""),
    action: text("action").notNull(),
    tableName: text("tableName").notNull(),
    objectId: text("objectId").notNull(),
    beforeValue: text("beforeValue"),
    afterValue: text("afterValue"),
    changedBy: text("changedBy").notNull().default(""),
    createdAt: text("createdAt").notNull().$defaultFn(nowIso),
  },
  (t) => [
    index("AuditLog_tableName_objectId_idx").on(t.tableName, t.objectId),
    index("AuditLog_createdAt_idx").on(t.createdAt),
    index("AuditLog_projectId_idx").on(t.projectId),
  ],
);

// ═══════════════════════════════════════════
// Relations (支持 query API 的 include 式加载)
// ═══════════════════════════════════════════

export const databaseRelations = defineRelations(
  {
    provider,
    modelDeployment,
    budget,
    apiKey,
    credential,
    spendLog,
    errorLog,
    dailySpend,
    auditLog,
  },
  (relations) => ({
    provider: {
      deployments: relations.many.modelDeployment({
        from: relations.provider.id,
        to: relations.modelDeployment.providerId,
      }),
    },
    modelDeployment: {
      provider: relations.one.provider({
        from: relations.modelDeployment.providerId,
        to: relations.provider.id,
      }),
    },
    budget: {
      keys: relations.many.apiKey({ from: relations.budget.id, to: relations.apiKey.budgetId }),
    },
    apiKey: {
      budget: relations.one.budget({ from: relations.apiKey.budgetId, to: relations.budget.id }),
    },
  }),
);
