import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects, users } from "./tables-1.js";

export const observationMedia = sqliteTable(
  "observation_media",
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
    observationId: text("observation_id").notNull(),
    field: text().notNull(),
  },
  (table) => [
    uniqueIndex("observation_media_project_id_trace_id_observation_id_media_id_field_key").on(
      table.projectId,
      table.traceId,
      table.observationId,
      table.mediaId,
      table.field,
    ),
    index("observation_media_project_id_media_id_idx").on(table.projectId, table.mediaId),
  ],
);

export const datasetItemMedia = sqliteTable(
  "dataset_item_media",
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
    datasetId: text("dataset_id").notNull(),
    datasetItemId: text("dataset_item_id").notNull(),
    datasetItemValidFrom: integer("dataset_item_valid_from", { mode: "timestamp_ms" }),
    field: text().notNull(),
    jsonPath: text("json_path"),
    referenceString: text("reference_string"),
  },
  (table) => [
    uniqueIndex("dataset_item_media_item_version_field_path_key").on(
      table.projectId,
      table.datasetItemId,
      table.datasetItemValidFrom,
      table.field,
      table.jsonPath,
    ),
    index("dataset_item_media_project_id_dataset_id_idx").on(table.projectId, table.datasetId),
    index("dataset_item_media_project_id_media_id_idx").on(table.projectId, table.mediaId),
  ],
);

export const billingMeterBackups = sqliteTable(
  "billing_meter_backups",
  {
    stripeCustomerId: text("stripe_customer_id").notNull(),
    meterId: text("meter_id").notNull(),
    startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
    endTime: integer("end_time", { mode: "timestamp_ms" }).notNull(),
    aggregatedValue: integer("aggregated_value").notNull(),
    eventName: text("event_name").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("billing_meter_backups_stripe_customer_id_meter_id_start_time_end_time_key").on(
      table.stripeCustomerId,
      table.meterId,
      table.startTime,
      table.endTime,
    ),
    index("billing_meter_backups_stripe_customer_id_meter_id_start_time_end_time_idx").on(
      table.stripeCustomerId,
      table.meterId,
      table.startTime,
      table.endTime,
    ),
  ],
);

export const llmSchemas = sqliteTable(
  "llm_schemas",
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
    description: text().notNull(),
    schema: text().notNull(),
  },
  (table) => [uniqueIndex("llm_schemas_project_id_name_key").on(table.projectId, table.name)],
);

export const llmTools = sqliteTable(
  "llm_tools",
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
    description: text().notNull(),
    parameters: text().notNull(),
  },
  (table) => [uniqueIndex("llm_tools_project_id_name_key").on(table.projectId, table.name)],
);

export const dashboards = sqliteTable("dashboards", {
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
  projectId: text("project_id").references((): AnySQLiteColumn => projects.id, {
    onDelete: "cascade",
    onUpdate: "cascade",
  }),
  name: text().notNull(),
  description: text().notNull(),
  definition: text().notNull(),
  filters: text().default("[]").notNull(),
});

export const dashboardWidgets = sqliteTable("dashboard_widgets", {
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
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "cascade",
    onUpdate: "cascade",
  }),
  name: text().notNull(),
  description: text().notNull(),
  view: text().notNull(),
  dimensions: text().notNull(),
  metrics: text().notNull(),
  filters: text().notNull(),
  chartType: text("chart_type").notNull(),
  chartConfig: text("chart_config").notNull(),
  minVersion: integer("min_version").default(1).notNull(),
});

export const tableViewPresets = sqliteTable(
  "table_view_presets",
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
    tableName: text("table_name").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    filters: text().notNull(),
    columnOrder: text("column_order").notNull(),
    columnVisibility: text("column_visibility").notNull(),
    searchQuery: text("search_query"),
    orderBy: text("order_by"),
  },
  (table) => [
    uniqueIndex("table_view_presets_project_id_table_name_name_key").on(
      table.projectId,
      table.tableName,
      table.name,
    ),
  ],
);

export const defaultViews = sqliteTable(
  "default_views",
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
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    viewName: text("view_name").notNull(),
    viewId: text("view_id").notNull(),
  },
  (table) => [index("default_views_project_id_view_name_idx").on(table.projectId, table.viewName)],
);

export const actions = sqliteTable(
  "actions",
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
    type: text().notNull(),
    config: text().notNull(),
  },
  (table) => [index("actions_project_id_idx").on(table.projectId)],
);

export const triggers = sqliteTable(
  "triggers",
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
    eventSource: text().notNull(),
    eventActions: text().notNull(),
    filter: text(),
    status: text().default("ACTIVE").notNull(),
  },
  (table) => [index("triggers_project_id_idx").on(table.projectId)],
);
