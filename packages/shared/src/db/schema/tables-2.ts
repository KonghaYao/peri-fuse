import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { inAppAgentConversations, organizations, projects, users } from "./tables-1.js";

export const inAppAgentPendingToolApprovals = sqliteTable(
  "in_app_agent_pending_tool_approvals",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    approvalFingerprint: text("approval_fingerprint").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("in_app_agent_pending_tool_approvals_expires_at_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.conversationId, table.projectId],
      foreignColumns: [inAppAgentConversations.id, inAppAgentConversations.projectId],
      name: "in_app_agent_pending_tool_approvals_conversation_id_project_id_in_app_agent_conversations_id_project_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.conversationId, table.toolCallId],
      name: "in_app_agent_pending_tool_approvals_project_id_conversation_id_tool_call_id_pk",
    }),
  ],
);

export const backgroundMigrations = sqliteTable(
  "background_migrations",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    script: text().notNull(),
    args: text().notNull(),
    state: text().default("{}").notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    failedAt: integer("failed_at", { mode: "timestamp_ms" }),
    failedReason: text("failed_reason"),
    workerId: text("worker_id"),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("background_migrations_name_key").on(table.name)],
);

export const llmApiKeys = sqliteTable(
  "llm_api_keys",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    provider: text().notNull(),
    adapter: text().notNull(),
    displaySecretKey: text("display_secret_key").notNull(),
    secretKey: text("secret_key").notNull(),
    baseUrl: text("base_url"),
    customModels: text("custom_models").default("[]").notNull(),
    withDefaultModels: integer("with_default_models", { mode: "boolean" }).default(true).notNull(),
    extraHeaders: text("extra_headers"),
    extraHeaderKeys: text("extra_header_keys").default("[]").notNull(),
    config: text(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (table) => [
    uniqueIndex("llm_api_keys_project_id_provider_key").on(table.projectId, table.provider),
    uniqueIndex("llm_api_keys_id_key").on(table.id),
  ],
);

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    id: text().primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    role: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("organization_memberships_org_id_user_id_key").on(table.orgId, table.userId),
    index("organization_memberships_user_id_idx").on(table.userId),
  ],
);

export const projectMemberships = sqliteTable(
  "project_memberships",
  {
    orgMembershipId: text("org_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade", onUpdate: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    role: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("project_memberships_org_membership_id_idx").on(table.orgMembershipId),
    index("project_memberships_project_id_idx").on(table.projectId),
    index("project_memberships_user_id_idx").on(table.userId),
    primaryKey({
      columns: [table.projectId, table.userId],
      name: "project_memberships_project_id_user_id_pk",
    }),
  ],
);

export const membershipInvitations = sqliteTable(
  "membership_invitations",
  {
    id: text().primaryKey().notNull(),
    email: text().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    orgRole: text("org_role").notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    projectRole: text("project_role"),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("membership_invitations_email_org_id_key").on(table.email, table.orgId),
    index("membership_invitations_email_idx").on(table.email),
    index("membership_invitations_org_id_idx").on(table.orgId),
    index("membership_invitations_project_id_idx").on(table.projectId),
    uniqueIndex("membership_invitations_id_key").on(table.id),
  ],
);

export const traceSessions = sqliteTable(
  "trace_sessions",
  {
    id: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    bookmarked: integer("bookmarked", { mode: "boolean" }).default(false).notNull(),
    public: integer("public", { mode: "boolean" }).default(false).notNull(),
    environment: text().default("default").notNull(),
  },
  (table) => [
    index("trace_sessions_project_id_created_at_idx").on(table.projectId, table.createdAt),
    primaryKey({ columns: [table.id, table.projectId], name: "trace_sessions_id_project_id_pk" }),
  ],
);

export const scoreConfigs = sqliteTable(
  "score_configs",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    dataType: text("data_type").notNull(),
    isArchived: integer("is_archived", { mode: "boolean" }).default(false).notNull(),
    minValue: real("min_value"),
    maxValue: real("max_value"),
    categories: text(),
    description: text(),
  },
  (table) => [
    uniqueIndex("score_configs_id_project_id_key").on(table.id, table.projectId),
    index("score_configs_updated_at_idx").on(table.updatedAt),
    index("score_configs_created_at_idx").on(table.createdAt),
    index("score_configs_categories_idx").on(table.categories),
    index("score_configs_project_id_idx").on(table.projectId),
    index("score_configs_is_archived_idx").on(table.isArchived),
    index("score_configs_data_type_idx").on(table.dataType),
  ],
);

export const annotationQueues = sqliteTable(
  "annotation_queues",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    description: text(),
    scoreConfigIds: text("score_config_ids").default("[]").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("annotation_queues_project_id_name_key").on(table.projectId, table.name),
    index("annotation_queues_project_id_created_at_idx").on(table.projectId, table.createdAt),
    index("annotation_queues_id_project_id_idx").on(table.id, table.projectId),
  ],
);

export const annotationQueueItems = sqliteTable(
  "annotation_queue_items",
  {
    id: text().primaryKey().notNull(),
    queueId: text("queue_id")
      .notNull()
      .references(() => annotationQueues.id, { onDelete: "cascade", onUpdate: "cascade" }),
    objectId: text("object_id").notNull(),
    objectType: text("object_type").notNull(),
    status: text().default("PENDING").notNull(),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    lockedByUserId: text("locked_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    annotatorUserId: text("annotator_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("annotation_queue_items_created_at_idx").on(table.createdAt),
    index("annotation_queue_items_annotator_user_id_idx").on(table.annotatorUserId),
    index("annotation_queue_items_object_id_object_type_project_id_queue_id_idx").on(
      table.objectId,
      table.objectType,
      table.projectId,
      table.queueId,
    ),
    index("annotation_queue_items_project_id_queue_id_status_idx").on(
      table.projectId,
      table.queueId,
      table.status,
    ),
    index("annotation_queue_items_id_project_id_idx").on(table.id, table.projectId),
  ],
);
