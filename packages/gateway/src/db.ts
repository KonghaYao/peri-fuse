/**
 * Drizzle client singleton for PeriGateway (backed by better-sqlite3).
 *
 * Migrated from Prisma. The database file is resolved from GATEWAY_DB_URL
 * (set by ./env). Tables are created on demand via ensureSchema().
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
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
  }
}

let _schemaReady = false;

/**
 * Locate the committed migration SQL (drizzle/0000_init.sql). Works both in dev
 * (src/db/db.ts) and in the compiled output (dist/db.js), since both are one
 * level below the package root that contains the drizzle/ folder.
 */
function findMigrationSql(): string {
  const candidates = [
    // Bundled CLI context: __dirname = dist/, SQL copied to dist/drizzle/
    path.resolve(__dirname, "drizzle/0000_init.sql"),
    path.resolve(__dirname, "../../drizzle/0000_init.sql"),
    path.resolve(__dirname, "../drizzle/0000_init.sql"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  throw new Error(
    `Gateway migration SQL not found. Looked in: ${candidates.join(", ")}`,
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
 * Create all gateway tables if they do not exist. Executes the committed
 * drizzle migration SQL. Idempotent: skips entirely when the tables already
 * exist (restart with existing DB).
 */
export function ensureSchema(): void {
  if (_schemaReady) return;
  const sqlite = getSqlite();
  if (schemaAlreadyApplied(sqlite)) {
    _schemaReady = true;
    return;
  }
  const sql = findMigrationSql();
  for (const raw of sql.split("--> statement-breakpoint")) {
    const stmt = raw.trim();
    if (stmt) sqlite.exec(stmt);
  }
  _schemaReady = true;
}
