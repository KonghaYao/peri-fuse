import {
  type AnySQLiteColumn,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { dashboards } from "./tables-6.js";

export const account = sqliteTable(
  "Account",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    type: text().notNull(),
    provider: text().notNull(),
    providerAccountId: text().notNull(),
    refreshToken: text("refresh_token"),
    accessToken: text("access_token"),
    expiresAt: integer("expires_at"),
    expiresIn: integer("expires_in"),
    extExpiresIn: integer("ext_expires_in"),
    tokenType: text("token_type"),
    scope: text(),
    idToken: text("id_token"),
    sessionState: text("session_state"),
    refreshTokenExpiresIn: integer("refresh_token_expires_in"),
    createdAt: integer("created_at"),
  },
  (table) => [
    uniqueIndex("Account_provider_providerAccountId_key").on(
      table.provider,
      table.providerAccountId,
    ),
    index("Account_user_id_idx").on(table.userId),
  ],
);

export const session = sqliteTable(
  "Session",
  {
    id: text().primaryKey().notNull(),
    sessionToken: text("session_token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("Session_session_token_key").on(table.sessionToken)],
);

export const users = sqliteTable(
  "users",
  {
    id: text().primaryKey().notNull(),
    name: text(),
    email: text(),
    emailVerified: integer("email_verified", { mode: "timestamp_ms" }),
    password: text(),
    image: text(),
    admin: integer("admin", { mode: "boolean" }).default(false).notNull(),
    v4BetaEnabled: integer("v4_beta_enabled", { mode: "boolean" }).default(false).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    featureFlags: text("feature_flags").default("[]").notNull(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

export const verificationTokens = sqliteTable(
  "verification_tokens",
  {
    identifier: text().notNull(),
    token: text().notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("verification_tokens_identifier_token_key").on(table.identifier, table.token),
    uniqueIndex("verification_tokens_token_key").on(table.token),
  ],
);

export const organizations = sqliteTable("organizations", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
  cloudConfig: text("cloud_config"),
  metadata: text(),
  cloudBillingCycleAnchor: integer("cloud_billing_cycle_anchor", {
    mode: "timestamp_ms",
  }).$defaultFn(() => new Date()),
  cloudBillingCycleUpdatedAt: integer("cloud_billing_cycle_updated_at", { mode: "timestamp_ms" }),
  cloudCurrentCycleUsage: integer("cloud_current_cycle_usage"),
  cloudFreeTierUsageThresholdState: text("cloud_free_tier_usage_threshold_state"),
  aiFeaturesEnabled: integer("ai_features_enabled", { mode: "boolean" }).default(false).notNull(),
  aiTelemetryEnabled: integer("ai_telemetry_enabled", { mode: "boolean" }).default(true).notNull(),
  sfdcOrgId: text("sfdc_org_id"),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text().primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    name: text().notNull(),
    retentionDays: integer("retention_days"),
    hasTraces: integer("has_traces", { mode: "boolean" }).default(false).notNull(),
    metadata: text(),
    homeDashboardId: text("home_dashboard_id").references((): AnySQLiteColumn => dashboards.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [index("projects_org_id_idx").on(table.orgId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    note: text(),
    publicKey: text("public_key").notNull(),
    hashedSecretKey: text("hashed_secret_key").notNull(),
    fastHashedSecretKey: text("fast_hashed_secret_key"),
    displaySecretKey: text("display_secret_key").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    isInAppAgentKey: integer("is_in_app_agent_key", { mode: "boolean" }).default(false).notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    scope: text().default("PROJECT").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdByApiKeyId: text("created_by_api_key_id"),
  },
  (table) => [
    index("api_keys_fast_hashed_secret_key_idx").on(table.fastHashedSecretKey),
    index("api_keys_hashed_secret_key_idx").on(table.hashedSecretKey),
    index("api_keys_public_key_idx").on(table.publicKey),
    index("api_keys_created_by_api_key_id_idx").on(table.createdByApiKeyId),
    index("api_keys_project_id_idx").on(table.projectId),
    index("api_keys_organization_id_idx").on(table.organizationId),
    uniqueIndex("api_keys_fast_hashed_secret_key_key").on(table.fastHashedSecretKey),
    uniqueIndex("api_keys_hashed_secret_key_key").on(table.hashedSecretKey),
    uniqueIndex("api_keys_public_key_key").on(table.publicKey),
    uniqueIndex("api_keys_id_key").on(table.id),
    foreignKey({
      columns: [table.createdByApiKeyId],
      foreignColumns: [table.id],
      name: "api_keys_created_by_api_key_id_api_keys_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("set null"),
  ],
);

export const inAppAgentConversations = sqliteTable(
  "in_app_agent_conversations",
  {
    id: text().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    title: text(),
    renamedByUserAt: integer("renamed_by_user_at", { mode: "timestamp_ms" }),
    visibilityScope: text("visibility_scope").default("PERSONAL").notNull(),
    providerSessionId: text("provider_session_id"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("in_app_agent_conversations_project_user_list_idx").on(
      table.projectId,
      table.createdByUserId,
      table.deletedAt,
      table.updatedAt,
      table.id,
    ),
    primaryKey({
      columns: [table.id, table.projectId],
      name: "in_app_agent_conversations_id_project_id_pk",
    }),
  ],
);

export const inAppAgentEvents = sqliteTable(
  "in_app_agent_events",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    type: text().notNull(),
    event: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("in_app_agent_events_project_run_idx").on(table.projectId, table.runId),
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [inAppAgentRuns.id, inAppAgentRuns.projectId],
      name: "in_app_agent_events_run_id_project_id_in_app_agent_runs_id_project_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.conversationId, table.projectId],
      foreignColumns: [inAppAgentConversations.id, inAppAgentConversations.projectId],
      name: "in_app_agent_events_conversation_id_project_id_in_app_agent_conversations_id_project_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.conversationId, table.sequenceNumber],
      name: "in_app_agent_events_project_id_conversation_id_sequence_number_pk",
    }),
  ],
);

export const inAppAgentRuns = sqliteTable(
  "in_app_agent_runs",
  {
    id: text().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    triggeredByUserId: text("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    model: text(),
    mcpApiKeyId: text("mcp_api_key_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    status: text(),
    request: text(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
    cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("in_app_agent_runs_project_conversation_created_idx").on(
      table.projectId,
      table.conversationId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.conversationId, table.projectId],
      foreignColumns: [inAppAgentConversations.id, inAppAgentConversations.projectId],
      name: "in_app_agent_runs_conversation_id_project_id_in_app_agent_conversations_id_project_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.id, table.projectId],
      name: "in_app_agent_runs_id_project_id_pk",
    }),
  ],
);
