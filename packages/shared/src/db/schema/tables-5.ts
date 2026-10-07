import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations, projects } from "./tables-1.js";
import { llmApiKeys } from "./tables-2.js";

export const defaultLlmModels = sqliteTable(
  "default_llm_models",
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
    llmApiKeyId: text("llm_api_key_id")
      .notNull()
      .references(() => llmApiKeys.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text().notNull(),
    adapter: text().notNull(),
    model: text().notNull(),
    modelParams: text("model_params"),
  },
  (table) => [uniqueIndex("default_llm_models_project_id_key").on(table.projectId)],
);

export const ssoConfigs = sqliteTable("sso_configs", {
  domain: text().primaryKey().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
  authProvider: text("auth_provider").notNull(),
  authConfig: text("auth_config"),
});

export const verifiedDomains = sqliteTable(
  "verified_domains",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    domain: text().notNull(),
    verificationToken: text("verification_token").notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("verified_domains_organization_id_domain_key").on(
      table.organizationId,
      table.domain,
    ),
    index("verified_domains_organization_id_idx").on(table.organizationId),
    uniqueIndex("verified_domains_verification_token_key").on(table.verificationToken),
  ],
);

export const posthogIntegrations = sqliteTable("posthog_integrations", {
  projectId: text("project_id")
    .primaryKey()
    .notNull()
    .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  encryptedPosthogApiKey: text("encrypted_posthog_api_key").notNull(),
  posthogHostName: text("posthog_host_name").notNull(),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
  exportSource: text("export_source").default("TRACES_OBSERVATIONS").notNull(),
});

export const mixpanelIntegrations = sqliteTable("mixpanel_integrations", {
  projectId: text("project_id")
    .primaryKey()
    .notNull()
    .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  encryptedMixpanelProjectToken: text("encrypted_mixpanel_project_token").notNull(),
  mixpanelRegion: text("mixpanel_region").notNull(),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
  exportSource: text("export_source").default("TRACES_OBSERVATIONS").notNull(),
});

export const blobStorageIntegrations = sqliteTable("blob_storage_integrations", {
  projectId: text("project_id")
    .primaryKey()
    .notNull()
    .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  type: text().notNull(),
  bucketName: text("bucket_name").notNull(),
  prefix: text().notNull(),
  accessKeyId: text("access_key_id"),
  secretAccessKey: text("secret_access_key"),
  region: text().notNull(),
  endpoint: text(),
  forcePathStyle: integer("force_path_style", { mode: "boolean" }).notNull(),
  nextSyncAt: integer("next_sync_at", { mode: "timestamp_ms" }),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  exportFrequency: text("export_frequency").notNull(),
  fileType: text("file_type").default("CSV").notNull(),
  exportMode: text("export_mode").default("FULL_HISTORY").notNull(),
  exportStartDate: integer("export_start_date", { mode: "timestamp_ms" }),
  exportSource: text("export_source").default("TRACES_OBSERVATIONS").notNull(),
  exportFieldGroups: text("export_field_groups").default("[]").notNull(),
  compressed: integer("compressed", { mode: "boolean" }).default(true).notNull(),
  exportTuning: text("export_tuning"),
  runStartedAt: integer("run_started_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  lastErrorAt: integer("last_error_at", { mode: "timestamp_ms" }),
  lastFailureNotificationSentAt: integer("last_failure_notification_sent_at", {
    mode: "timestamp_ms",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export const webCalloutEndpoints = sqliteTable(
  "web_callout_endpoints",
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
    name: text().default("Default").notNull(),
    url: text().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    toastMessage: text("toast_message").default("Callout sent").notNull(),
    requestHeaders: text("request_headers"),
    requestHeaderKeys: text("request_header_keys").default("[]").notNull(),
  },
  (table) => [
    index("web_callout_endpoints_project_id_enabled_idx").on(table.projectId, table.enabled),
    index("web_callout_endpoints_project_id_idx").on(table.projectId),
  ],
);

export const batchExports = sqliteTable(
  "batch_exports",
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
    userId: text("user_id").notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    name: text().notNull(),
    status: text().notNull(),
    query: text().notNull(),
    format: text().notNull(),
    url: text(),
    log: text(),
  },
  (table) => [
    index("batch_exports_status_idx").on(table.status),
    index("batch_exports_project_id_user_id_idx").on(table.projectId, table.userId),
  ],
);

export const batchActions = sqliteTable(
  "batch_actions",
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
    userId: text("user_id").notNull(),
    actionType: text("action_type").notNull(),
    tableName: text("table_name").notNull(),
    status: text().notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    query: text().notNull(),
    config: text(),
    totalCount: integer("total_count"),
    processedCount: integer("processed_count"),
    failedCount: integer("failed_count"),
    log: text(),
  },
  (table) => [
    index("batch_actions_project_id_action_type_idx").on(table.projectId, table.actionType),
    index("batch_actions_status_idx").on(table.status),
    index("batch_actions_project_id_user_id_idx").on(table.projectId, table.userId),
  ],
);

export const media = sqliteTable(
  "media",
  {
    id: text().notNull(),
    sha256Hash: text("sha_256_hash").notNull(),
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
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }),
    uploadHttpStatus: integer("upload_http_status"),
    uploadHttpError: text("upload_http_error"),
    bucketPath: text("bucket_path").notNull(),
    bucketName: text("bucket_name").notNull(),
    contentType: text("content_type").notNull(),
    contentLength: integer("content_length").notNull(),
  },
  (table) => [
    uniqueIndex("media_project_id_sha_256_hash_key").on(table.projectId, table.sha256Hash),
    uniqueIndex("media_project_id_id_key").on(table.projectId, table.id),
    index("media_project_id_created_at_idx").on(table.projectId, table.createdAt),
  ],
);

export const traceMedia = sqliteTable(
  "trace_media",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    mediaId: text("media_id").notNull(),
    traceId: text("trace_id").notNull(),
    field: text().notNull(),
  },
  (table) => [
    uniqueIndex("trace_media_project_id_trace_id_media_id_field_key").on(
      table.projectId,
      table.traceId,
      table.mediaId,
      table.field,
    ),
    index("trace_media_project_id_media_id_idx").on(table.projectId, table.mediaId),
  ],
);
