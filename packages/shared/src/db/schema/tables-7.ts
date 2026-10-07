import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations, projects, users } from "./tables-1.js";
import { actions, triggers } from "./tables-6.js";

export const automations = sqliteTable(
  "automations",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (table) => [
    index("automations_project_id_name_idx").on(table.projectId, table.name),
    index("automations_project_id_action_id_trigger_id_idx").on(
      table.projectId,
      table.actionId,
      table.triggerId,
    ),
  ],
);

export const automationExecutions = sqliteTable(
  "automation_executions",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    sourceId: text("source_id").notNull(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade", onUpdate: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    status: text().default("PENDING").notNull(),
    input: text().notNull(),
    output: text(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    error: text(),
  },
  (table) => [
    index("automation_executions_project_id_idx").on(table.projectId),
    index("automation_executions_action_id_idx").on(table.actionId),
    index("automation_executions_trigger_id_idx").on(table.triggerId),
  ],
);

export const monitors = sqliteTable(
  "monitors",
  {
    id: text().primaryKey().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    view: text().notNull(),
    filters: text().notNull(),
    metric: text().notNull(),
    windowMs: integer("window_ms").notNull(),
    cadenceMs: integer("cadence_ms").notNull(),
    thresholdOperator: text("threshold_operator").notNull(),
    alertThreshold: real("alert_threshold").notNull(),
    warningThreshold: real("warning_threshold"),
    severity: text().default("UNKNOWN").notNull(),
    severityChangedAt: integer("severity_changed_at", { mode: "timestamp_ms" }),
    noData: text("no_data").notNull(),
    renotify: text().notNull(),
    status: text().default("ACTIVE").notNull(),
    schedulerBatchId: integer("scheduler_batch_id").notNull(),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    lastPublishedAt: integer("last_published_at", { mode: "timestamp_ms" }),
    lastClaimedAt: integer("last_claimed_at", { mode: "timestamp_ms" }),
    lastCompletedAt: integer("last_completed_at", { mode: "timestamp_ms" }),
    name: text().notNull(),
    tags: text().default("[]").notNull(),
    triggerIds: text("trigger_ids").default("[]").notNull(),
    alertedAt: integer("alerted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("monitors_scheduler_tick_idx").on(table.nextRunAt, table.schedulerBatchId),
    index("monitors_scheduler_batch_id_idx").on(table.schedulerBatchId),
    index("monitors_project_id_idx").on(table.projectId),
  ],
);

export const slackIntegrations = sqliteTable(
  "slack_integrations",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    teamId: text("team_id").notNull(),
    teamName: text("team_name").notNull(),
    botToken: text("bot_token").notNull(),
    botUserId: text("bot_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("slack_integrations_team_id_idx").on(table.teamId),
    uniqueIndex("slack_integrations_project_id_key").on(table.projectId),
  ],
);

export const pendingDeletions = sqliteTable(
  "pending_deletions",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    object: text().notNull(),
    objectId: text("object_id").notNull(),
    isDeleted: integer("is_deleted", { mode: "boolean" }).default(false).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("pending_deletions_object_id_object_idx").on(table.objectId, table.object),
    index("pending_deletions_project_id_object_is_deleted_object_id_id_idx").on(
      table.projectId,
      table.object,
      table.isDeleted,
      table.objectId,
      table.id,
    ),
  ],
);

export const surveys = sqliteTable("surveys", {
  id: text().primaryKey().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull(),
  surveyName: text("survey_name").notNull(),
  response: text().notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
  userEmail: text("user_email"),
  orgId: text("org_id").references(() => organizations.id, {
    onDelete: "cascade",
    onUpdate: "cascade",
  }),
});

export const cloudSpendAlerts = sqliteTable(
  "cloud_spend_alerts",
  {
    id: text().primaryKey().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade", onUpdate: "cascade" }),
    title: text().notNull(),
    threshold: real("threshold").notNull(),
    triggeredAt: integer("triggered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [index("cloud_spend_alerts_org_id_idx").on(table.orgId)],
);
