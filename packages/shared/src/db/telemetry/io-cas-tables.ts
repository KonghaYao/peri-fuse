import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Content-addressed storage for `observations.input` (design §5.3).
 *
 * Keys are project scoped: the same message stored by two projects is two rows
 * with distinct payloads, never a shared row. All byte columns are declared as
 * `blob(..., { mode: "buffer" })` so the driver hands back `Uint8Array` values.
 */

export const ioCasChunks = sqliteTable(
  "io_cas_chunks",
  {
    projectId: text("project_id").notNull(),
    contentHash: blob("content_hash", { mode: "buffer" }).notNull(),
    codec: integer("codec").notNull(),
    rawSize: integer("raw_size").notNull(),
    payload: blob("payload", { mode: "buffer" }).notNull(),
    markEpoch: integer("mark_epoch").notNull().default(sql`0`),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.contentHash] }),
    check("io_cas_chunks_content_hash_check", sql`length(${table.contentHash}) = 32`),
    check("io_cas_chunks_codec_check", sql`${table.codec} IN (0, 1)`),
    check(
      "io_cas_chunks_raw_size_check",
      sql`${table.rawSize} > 0 AND ${table.rawSize} <= 33554432`,
    ),
    check("io_cas_chunks_mark_epoch_check", sql`${table.markEpoch} >= 0`),
    index("idx_io_cas_gc").on(table.projectId, table.markEpoch, table.contentHash),
  ],
);

export const ioCasGcState = sqliteTable(
  "io_cas_gc_state",
  {
    // The primary key is declared at table level on purpose: SQLite accepts NULL
    // in an inline `TEXT PRIMARY KEY`, and drizzle-kit drops NOT NULL from
    // column-level primary keys, which would silently diverge from the design DDL.
    projectId: text("project_id").notNull(),
    epoch: integer("epoch").notNull().default(sql`0`),
    phase: text("phase").notNull().default(sql`'idle'`),
    rootCursor: text("root_cursor"),
    sweepCursor: blob("sweep_cursor", { mode: "buffer" }),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId] }),
    check("io_cas_gc_state_epoch_check", sql`${table.epoch} >= 0`),
    check(
      "io_cas_gc_state_phase_check",
      sql`${table.phase} IN ('idle', 'mark', 'sweep', 'blocked')`,
    ),
    check(
      "io_cas_gc_state_sweep_cursor_check",
      sql`${table.sweepCursor} IS NULL OR length(${table.sweepCursor}) = 32`,
    ),
  ],
);

export const ioCasMigrationState = sqliteTable(
  "io_cas_migration_state",
  {
    projectId: text("project_id").notNull(),
    job: text("job").notNull(),
    pass: integer("pass").notNull().default(sql`1`),
    cursorId: text("cursor_id"),
    status: text("status").notNull().default(sql`'running'`),
    scanned: integer("scanned").notNull().default(sql`0`),
    converted: integer("converted").notNull().default(sql`0`),
    skipped: integer("skipped").notNull().default(sql`0`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.job] }),
    check("io_cas_migration_state_job_check", sql`${table.job} IN ('backfill-v1', 'expand-v1')`),
    check(
      "io_cas_migration_state_status_check",
      sql`${table.status} IN ('running', 'paused', 'done', 'failed')`,
    ),
  ],
);

/**
 * Decision D-1: the codec-2 root-scan index must never run inside the startup
 * migration. `applyLocalMigrations` applies every migration in an IMMEDIATE
 * transaction from the telemetry adapter constructor
 * (`sqlite-telemetry-adapter.ts:87`), and building this index over a large
 * `observations` table would hold the single writer slot while scanning it,
 * clashing with design §10.1 ("do not scan 1.5GB inside a startup transaction").
 *
 * It is therefore intentionally absent from both the Drizzle schema and
 * `telemetry-drizzle/`. The backfill / GC admin command creates it explicitly
 * before the first codec-2 root scan, using the statements below.
 */
export const IO_CAS_ROOTS_INDEX_NAME = "idx_obs_cas_roots";

/** `IF NOT EXISTS` keeps the operator step re-runnable across resumes. */
export const IO_CAS_ROOTS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${IO_CAS_ROOTS_INDEX_NAME} ON observations(project_id, input_codec, id);`;
