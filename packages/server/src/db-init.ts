/**
 * Auto-initialize the metadata/auth SQLite database on first boot.
 *
 * Migrated from Prisma (`prisma db push`) to Drizzle: the shared package ships
 * its generated migration SQL (drizzle/*.sql) and applies it via `ensureSchema`
 * against the better-sqlite3 connection. Subsequent boots are no-ops (guarded
 * inside the shared client). The shared client also enables WAL mode and creates
 * the database directory, so no separate handling is needed here.
 */
export { ensureSchema as ensurePrismaSchema } from "@peri-fuse/shared/src/db";
