import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects, users } from "./tables-1.js";
import { annotationQueues } from "./tables-2.js";

export const annotationQueueAssignments = sqliteTable(
  "annotation_queue_assignments",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    queueId: text("queue_id")
      .notNull()
      .references(() => annotationQueues.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("annotation_queue_assignments_project_id_queue_id_user_id_key").on(
      table.projectId,
      table.queueId,
      table.userId,
    ),
  ],
);

export const cronJobs = sqliteTable("cron_jobs", {
  name: text().primaryKey().notNull(),
  lastRun: integer("last_run", { mode: "timestamp_ms" }),
  jobStartedAt: integer("job_started_at", { mode: "timestamp_ms" }),
  state: text(),
});

export const datasets = sqliteTable(
  "datasets",
  {
    id: text().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    description: text(),
    metadata: text(),
    remoteExperimentUrl: text("remote_experiment_url"),
    remoteExperimentPayload: text("remote_experiment_payload"),
    remoteExperimentEnabled: integer("remote_experiment_enabled", { mode: "boolean" })
      .default(true)
      .notNull(),
    inputSchema: text("input_schema"),
    expectedOutputSchema: text("expected_output_schema"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("datasets_project_id_name_key").on(table.projectId, table.name),
    index("datasets_updated_at_idx").on(table.updatedAt),
    index("datasets_created_at_idx").on(table.createdAt),
    primaryKey({ columns: [table.id, table.projectId], name: "datasets_id_project_id_pk" }),
  ],
);

export const datasetItems = sqliteTable(
  "dataset_items",
  {
    id: text().notNull(),
    projectId: text("project_id").notNull(),
    status: text().default("ACTIVE"),
    input: text(),
    expectedOutput: text("expected_output"),
    metadata: text(),
    sourceTraceId: text("source_trace_id"),
    sourceObservationId: text("source_observation_id"),
    datasetId: text("dataset_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    validFrom: integer("valid_from", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    validTo: integer("valid_to", { mode: "timestamp_ms" }),
    isDeleted: integer("is_deleted", { mode: "boolean" }).default(false).notNull(),
  },
  (table) => [
    index("dataset_items_updated_at_idx").on(table.updatedAt),
    index("dataset_items_created_at_idx").on(table.createdAt),
    index("dataset_items_dataset_id_idx").on(table.datasetId),
    index("dataset_items_source_observation_id_idx").on(table.sourceObservationId),
    index("dataset_items_source_trace_id_idx").on(table.sourceTraceId),
    index("dataset_items_project_id_id_valid_from_idx").on(
      table.projectId,
      table.id,
      table.validFrom,
    ),
    index("dataset_items_project_id_valid_to_idx").on(table.projectId, table.validTo),
    foreignKey({
      columns: [table.datasetId, table.projectId],
      foreignColumns: [datasets.id, datasets.projectId],
      name: "dataset_items_dataset_id_project_id_datasets_id_project_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.id, table.projectId, table.validFrom],
      name: "dataset_items_id_project_id_valid_from_pk",
    }),
  ],
);

export const datasetRuns = sqliteTable(
  "dataset_runs",
  {
    id: text().notNull(),
    projectId: text("project_id").notNull(),
    name: text().notNull(),
    description: text(),
    metadata: text(),
    datasetId: text("dataset_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("dataset_runs_dataset_id_project_id_name_key").on(
      table.datasetId,
      table.projectId,
      table.name,
    ),
    index("dataset_runs_updated_at_idx").on(table.updatedAt),
    index("dataset_runs_created_at_idx").on(table.createdAt),
    index("dataset_runs_dataset_id_idx").on(table.datasetId),
    foreignKey({
      columns: [table.datasetId, table.projectId],
      foreignColumns: [datasets.id, datasets.projectId],
      name: "dataset_runs_dataset_id_project_id_datasets_id_project_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({ columns: [table.id, table.projectId], name: "dataset_runs_id_project_id_pk" }),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
    content: text().notNull(),
    authorUserId: text("author_user_id"),
    dataField: text("data_field"),
    path: text().default("[]").notNull(),
    rangeStart: text("range_start").default("[]").notNull(),
    rangeEnd: text("range_end").default("[]").notNull(),
  },
  (table) => [
    index("comments_project_id_object_type_object_id_idx").on(
      table.projectId,
      table.objectType,
      table.objectId,
    ),
  ],
);

export const commentReactions = sqliteTable(
  "comment_reactions",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade", onUpdate: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    emoji: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("comment_reactions_comment_id_user_id_emoji_key").on(
      table.commentId,
      table.userId,
      table.emoji,
    ),
  ],
);

export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    channel: text().notNull(),
    type: text().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("notification_preferences_user_id_project_id_channel_type_key").on(
      table.userId,
      table.projectId,
      table.channel,
      table.type,
    ),
  ],
);

export const prompts = sqliteTable(
  "prompts",
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
    createdBy: text("created_by").notNull(),
    prompt: text().notNull(),
    name: text().notNull(),
    version: integer().notNull(),
    type: text().default("text").notNull(),
    isActive: integer("is_active", { mode: "boolean" }),
    config: text().default("{}").notNull(),
    tags: text().default("[]").notNull(),
    labels: text().default("[]").notNull(),
    commitMessage: text("commit_message"),
  },
  (table) => [
    uniqueIndex("prompts_project_id_name_version_key").on(
      table.projectId,
      table.name,
      table.version,
    ),
    index("prompts_tags_idx").on(table.tags),
    index("prompts_updated_at_idx").on(table.updatedAt),
    index("prompts_created_at_idx").on(table.createdAt),
    index("prompts_project_id_id_idx").on(table.projectId, table.id),
  ],
);
