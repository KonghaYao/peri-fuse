import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const searchDirty = sqliteTable(
  "search_dirty",
  {
    projectId: text("project_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    revision: integer("revision").notNull(),
    eventTime: text("event_time"),
    attempts: integer("attempts").notNull().default(sql`0`),
    nextAttemptAt: text("next_attempt_at"),
    lastError: text("last_error"),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.sourceKind, table.sourceId] })],
);

export const searchSourceRevisions = sqliteTable(
  "search_source_revisions",
  {
    projectId: text("project_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.sourceKind, table.sourceId] })],
);

export const searchIndexState = sqliteTable("search_index_state", {
  projectId: text("project_id").primaryKey(),
  indexVersion: integer("index_version").notNull().default(sql`1`),
  coverage: text("coverage").notNull().default(sql`'new'`),
  pending: integer("pending").notNull().default(sql`0`),
  traceCursor: integer("trace_cursor").notNull().default(sql`0`),
  observationCursor: integer("observation_cursor").notNull().default(sql`0`),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const dailyStatsDirty = sqliteTable(
  "daily_stats_dirty",
  {
    projectId: text("project_id").notNull(),
    day: text("day").notNull(),
    revision: integer("revision").notNull().default(sql`1`),
    dirty: integer("dirty").notNull().default(sql`1`),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.day] })],
);

export const telemetryRetentionState = sqliteTable(
  "telemetry_retention_state",
  {
    id: integer("id").primaryKey(),
    cutoffDay: text("cutoff_day").notNull(),
  },
  (table) => [check("telemetry_retention_state_id_check", sql`${table.id} = 1`)],
);

export const ingestionFieldVersions = sqliteTable(
  "ingestion_field_versions",
  {
    projectId: text("project_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    versions: text("versions").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.entityType, table.entityId] })],
);
