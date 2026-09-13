/**
 * Drizzle client singleton for PeriGateway (backed by better-sqlite3).
 *
 * Migrated from Prisma. The database file is resolved from GATEWAY_DB_URL
 * (set by ./env). Tables are created on demand via ensureSchema().
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

let _sqlite: Database.Database | null = null;
let _db: Db | null = null;

function resolveDbPath(): string {
  const url = process.env.GATEWAY_DB_URL ?? "file:./.peri-fuse/gateway.db";
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

function getSqlite(): Database.Database {
  if (_sqlite) return _sqlite;
  _sqlite = new Database(resolveDbPath());
  // Match the previous Prisma connection settings.
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("busy_timeout = 5000");
  _sqlite.pragma("foreign_keys = ON");
  return _sqlite;
}

export function getDb(): Db {
  if (!_db) {
    _db = drizzle(getSqlite(), { schema });
  }
  return _db;
}

/** Close the underlying SQLite connection (used on shutdown). */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    _schemaReady = false;
  }
}

let _schemaReady = false;

/**
 * Locate a committed migration SQL file by name. Works both in dev
 * (src/db/db.ts) and in the compiled output (dist/db.js), since both are one
 * level below the package root that contains the drizzle/ folder.
 */
function findMigrationSql(filename: string): string {
  const candidates = [
    // Bundled CLI context: __dirname = dist/, SQL copied to dist/drizzle/
    path.resolve(__dirname, `drizzle/${filename}`),
    path.resolve(__dirname, `../../drizzle/${filename}`),
    path.resolve(__dirname, `../drizzle/${filename}`),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  throw new Error(
    `Gateway migration SQL not found (${filename}). Looked in: ${candidates.join(", ")}`,
  );
}

/**
 * Returns true if the gateway database already has its tables (schema applied
 * by a previous boot). Makes ensureSchema() idempotent so restarting against
 * an existing database does not re-run CREATE TABLE.
 */
function schemaAlreadyApplied(sqlite: Database.Database): boolean {
  try {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ApiKey'")
      .get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Check if the project scoping migration (0001) has been applied by detecting
 * the projectId column on the Provider table.
 */
function projectScopingApplied(sqlite: Database.Database): boolean {
  try {
    const cols = sqlite.prepare("PRAGMA table_info('Provider')").all() as { name: string }[];
    return cols.some((c) => c.name === "projectId");
  } catch {
    return false;
  }
}

function runMigrationFile(sqlite: Database.Database, filename: string): void {
  const sql = findMigrationSql(filename);
  for (const raw of sql.split("--> statement-breakpoint")) {
    const stmt = raw.trim();
    if (stmt) sqlite.exec(stmt);
  }
}

/**
 * Create all gateway tables if they do not exist, then apply incremental
 * migrations. Idempotent: skips steps already applied.
 */
export function ensureSchema(): void {
  if (_schemaReady) return;
  const sqlite = getSqlite();

  // Step 1: base schema (0000_init.sql)
  if (!schemaAlreadyApplied(sqlite)) {
    runMigrationFile(sqlite, "0000_init.sql");
  }

  // Step 2: project scoping migration (0001)
  if (!projectScopingApplied(sqlite)) {
    runMigrationFile(sqlite, "0001_add_project_scoping.sql");
  }

  // Daily aggregation must use the same project boundary as its source events.
  const scopedDailyIndex = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get("DailySpend_projectId_apiKey_date_model_provider_key");
  if (!scopedDailyIndex) {
    sqlite.transaction(() => {
      runMigrationFile(sqlite, "0002_scope_daily_spend.sql");
    })();
  }

  _schemaReady = true;
}
