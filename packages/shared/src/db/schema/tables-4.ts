import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./tables-1.js";
import { prompts } from "./tables-3.js";

export const promptDependencies = sqliteTable(
  "prompt_dependencies",
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
    parentId: text("parent_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    childName: text("child_name").notNull(),
    childLabel: text("child_label"),
    childVersion: integer("child_version"),
  },
  (table) => [
    index("prompt_dependencies_project_id_child_name").on(table.projectId, table.childName),
    index("prompt_dependencies_project_id_parent_id").on(table.projectId, table.parentId),
  ],
);

export const promptProtectedLabels = sqliteTable(
  "prompt_protected_labels",
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
    label: text().notNull(),
  },
  (table) => [
    uniqueIndex("prompt_protected_labels_project_id_label_key").on(table.projectId, table.label),
  ],
);

export const models = sqliteTable(
  "models",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    modelName: text("model_name").notNull(),
    matchPattern: text("match_pattern").notNull(),
    startDate: integer("start_date", { mode: "timestamp_ms" }),
    inputPrice: real("input_price"),
    outputPrice: real("output_price"),
    totalPrice: real("total_price"),
    unit: text(),
    tokenizerId: text("tokenizer_id"),
    tokenizerConfig: text("tokenizer_config"),
  },
  (table) => [
    uniqueIndex("models_project_id_model_name_start_date_unit_key").on(
      table.projectId,
      table.modelName,
      table.startDate,
      table.unit,
    ),
    index("models_model_name_idx").on(table.modelName),
  ],
);

export const prices = sqliteTable(
  "prices",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    modelId: text("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade", onUpdate: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    pricingTierId: text("pricing_tier_id")
      .notNull()
      .references(() => pricingTiers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    usageType: text("usage_type").notNull(),
    price: real("price").notNull(),
  },
  (table) => [
    uniqueIndex("prices_model_id_usage_type_pricing_tier_id_key").on(
      table.modelId,
      table.usageType,
      table.pricingTierId,
    ),
    index("prices_pricing_tier_id_idx").on(table.pricingTierId),
  ],
);

export const pricingTiers = sqliteTable(
  "pricing_tiers",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    modelId: text("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).default(false).notNull(),
    priority: integer().notNull(),
    conditions: text().notNull(),
  },
  (table) => [
    uniqueIndex("pricing_tiers_model_id_name_key").on(table.modelId, table.name),
    uniqueIndex("pricing_tiers_model_id_priority_key").on(table.modelId, table.priority),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    type: text().default("USER").notNull(),
    apiKeyId: text("api_key_id"),
    userId: text("user_id"),
    orgId: text("org_id").notNull(),
    userOrgRole: text("user_org_role"),
    projectId: text("project_id"),
    userProjectRole: text("user_project_role"),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    action: text().notNull(),
    before: text(),
    after: text(),
  },
  (table) => [
    index("audit_logs_updated_at_idx").on(table.updatedAt),
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_org_id_idx").on(table.orgId),
    index("audit_logs_user_id_idx").on(table.userId),
    index("audit_logs_api_key_id_idx").on(table.apiKeyId),
    index("audit_logs_project_id_idx").on(table.projectId),
  ],
);

export const evalTemplates = sqliteTable(
  "eval_templates",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    name: text().notNull(),
    version: integer().notNull(),
    prompt: text(),
    type: text().default("LLM_AS_JUDGE").notNull(),
    partner: text(),
    model: text(),
    provider: text(),
    modelParams: text("model_params"),
    vars: text().default("[]").notNull(),
    outputSchema: text("output_schema"),
    sourceCode: text("source_code"),
    sourceCodeLanguage: text("source_code_language"),
  },
  (table) => [
    uniqueIndex("eval_templates_project_id_name_version_key").on(
      table.projectId,
      table.name,
      table.version,
    ),
    index("eval_templates_project_id_id_idx").on(table.projectId, table.id),
  ],
);

export const jobConfigurations = sqliteTable(
  "job_configurations",
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
    jobType: text("job_type").notNull(),
    status: text().default("ACTIVE").notNull(),
    blockedAt: integer("blocked_at", { mode: "timestamp_ms" }),
    blockReason: text("block_reason"),
    blockMessage: text("block_message"),
    evalTemplateId: text("eval_template_id").references(() => evalTemplates.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    scoreName: text("score_name").notNull(),
    filter: text().notNull(),
    targetObject: text("target_object").notNull(),
    variableMapping: text("variable_mapping").notNull(),
    sampling: real("sampling").notNull(),
    delay: integer().notNull(),
    timeScope: text("time_scope").default("[]").notNull(),
  },
  (table) => [index("job_configurations_project_id_id_idx").on(table.projectId, table.id)],
);

export const jobExecutions = sqliteTable(
  "job_executions",
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
    jobConfigurationId: text("job_configuration_id")
      .notNull()
      .references(() => jobConfigurations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    jobTemplateId: text("job_template_id"),
    status: text().notNull(),
    startTime: integer("start_time", { mode: "timestamp_ms" }),
    endTime: integer("end_time", { mode: "timestamp_ms" }),
    error: text(),
    jobInputTraceId: text("job_input_trace_id"),
    jobInputTraceTimestamp: integer("job_input_trace_timestamp", { mode: "timestamp_ms" }),
    jobInputObservationId: text("job_input_observation_id"),
    jobInputDatasetItemId: text("job_input_dataset_item_id"),
    jobInputDatasetItemValidFrom: integer("job_input_dataset_item_valid_from", {
      mode: "timestamp_ms",
    }),
    jobOutputScoreId: text("job_output_score_id"),
    executionTraceId: text("execution_trace_id"),
  },
  (table) => [
    index("job_executions_job_configuration_id_idx").on(table.jobConfigurationId),
    index("job_executions_project_id_job_output_score_id_idx").on(
      table.projectId,
      table.jobOutputScoreId,
    ),
    index("job_executions_project_id_job_configuration_id_job_input_trace_id_idx").on(
      table.projectId,
      table.jobConfigurationId,
      table.jobInputTraceId,
    ),
  ],
);
