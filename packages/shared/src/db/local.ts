import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database, type Transaction } from "@tursodatabase/database";
import {
  isRemoteDatabaseUrl,
  resolveLocalEngine,
  validateDatabaseConfig,
} from "./connection-config";
import { assertStoredReadSnapshotCompatible } from "./read-snapshot";
import { registerLocalReadSnapshot } from "./read-snapshot-local";
import { createRemoteDatabase } from "./remote";

export type { ReadSnapshotMetrics, ReadSnapshotOptions } from "./read-snapshot";
export {
  assertReadSnapshotSupported,
  getReadSnapshotCapability,
  withReadSnapshot,
} from "./read-snapshot";

import {
  assertSqliteRuntime,
  createSqliteDatabase,
  ensureSqliteWal,
  initializeSqliteConnection,
  inspectSqliteTables,
  isSqliteDatabase,
} from "./sqlite";

export {
  isRemoteDatabaseUrl,
  resolveDatabaseConfig,
  resolveLocalEngine,
  validateDatabaseConfig,
} from "./connection-config";
export { getRemoteDatabaseConfig } from "./remote";
/** True when a local client is backed by the optional Bun `bun:sqlite` engine. */
export { isSqliteDatabase } from "./sqlite";

export type LocalDatabase = Database;
export type LocalExecutor = Database | Transaction;
export const LOCAL_DATABASE_OPTIONS = {
  experimental: ["multiprocess_wal"] as ["multiprocess_wal"],
};

export function findLocalPackageRoot(directory: string): string {
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Cannot locate the database migration package");
}

export function readLocalMigrations(directory: string): { name: string; sql: string }[] {
  const migrations: { name: string; sql: string }[] = [];
  function visit(current: string, prefix = "") {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(current, entry.name), `${name}/`);
      else if (entry.name.endsWith(".sql"))
        migrations.push({ name, sql: readFileSync(join(current, entry.name), "utf8") });
    }
  }
  visit(directory);
  if (!migrations.length) throw new Error(`No migration SQL found in ${directory}`);
  return migrations;
}

export async function withLocalTransaction<T>(
  db: LocalExecutor,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return "transactionAsync" in db ? db.transactionAsync(callback).immediate() : callback(db);
}

export function resolveLocalPath(url: string, directory = process.cwd()): string {
  if (url === ":memory:") return url;
  if (/^[a-z]+:\/\//i.test(url)) throw new Error("Only local database paths are supported");
  return resolve(directory, url.startsWith("file:") ? url.slice(5) : url);
}

export function createLocalDatabase(url: string, readonly = false, authToken?: string): Database {
  const engine = resolveLocalEngine();
  const config = validateDatabaseConfig({ url, authToken });
  if (isRemoteDatabaseUrl(config.url)) return createRemoteDatabase(config, readonly);
  url = config.url;
  // Reject an unsupported runtime before creating directories or files.
  if (engine === "sqlite") assertSqliteRuntime();
  const filename = resolveLocalPath(url);
  if (filename !== ":memory:" && !readonly) mkdirSync(dirname(filename), { recursive: true });
  if (engine === "sqlite") return createSqliteDatabase(filename, readonly);
  return registerLocalReadSnapshot(
    new Database(filename, {
      ...(filename === ":memory:" ? {} : LOCAL_DATABASE_OPTIONS),
      readonly,
      fileMustExist: readonly,
      timeout: 5000,
    }),
  );
}

export async function initializeLocalDatabase(db: Database): Promise<void> {
  await db.connect();
  // The sqlite engine already applied foreign keys on connect; re-apply them
  // through its internal path so neither engine's WAL mode is activated here.
  if (await initializeSqliteConnection(db)) return;
  await db.exec("PRAGMA foreign_keys = ON");
  await assertStoredReadSnapshotCompatible(db);
}

export async function openLocalDatabase(
  url: string,
  readonly = false,
  authToken?: string,
): Promise<Database> {
  const db = createLocalDatabase(url, readonly, authToken);
  try {
    await initializeLocalDatabase(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

const CREATE_MIGRATIONS_TABLE =
  "CREATE TABLE IF NOT EXISTS _perifuse_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))";

/**
 * Lists existing tables for the legacy preflight. The sqlite engine answers
 * from `sqlite_master` without activating WAL, so a legacy file is rejected
 * before any persistent pragma rewrites it.
 */
async function inspectLocalTables(db: Database): Promise<{ name: string }[]> {
  const tables = await inspectSqliteTables(db);
  if (tables) return tables;
  return (await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) as { name: string }[];
}

/**
 * Creates the migration table. The sqlite engine wraps this DDL in its own
 * IMMEDIATE transaction so concurrent starts retry the BEGIN instead of
 * racing on the single writer slot.
 */
async function createMigrationsTable(db: Database): Promise<void> {
  if (!isSqliteDatabase(db)) {
    await db.exec(CREATE_MIGRATIONS_TABLE);
    return;
  }
  await db
    .transactionAsync(async (tx) => {
      await tx.exec(CREATE_MIGRATIONS_TABLE);
    })
    .immediate();
}

export async function applyLocalMigrations(
  db: Database,
  migrations: { name: string; sql: string }[],
): Promise<void> {
  await initializeLocalDatabase(db);
  const tables = await inspectLocalTables(db);
  if (tables.length && !tables.some((table) => table.name === "_perifuse_migrations")) {
    throw new Error(
      "Existing legacy database is not supported. Select a new database path; the old database is not migrated or deleted.",
    );
  }
  await ensureSqliteWal(db);
  await createMigrationsTable(db);
  for (const migration of migrations) {
    await db
      .transactionAsync(async (tx) => {
        if (await tx.get("SELECT 1 FROM _perifuse_migrations WHERE name=?", migration.name)) return;
        for (const statement of migration.sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.exec(statement);
        }
        await tx.run("INSERT INTO _perifuse_migrations(name) VALUES(?)", migration.name);
      })
      .immediate();
  }
}

export function localFileExists(url: string): boolean {
  const filename = resolveLocalPath(url);
  return filename !== ":memory:" && existsSync(filename);
}

export function resolveDatabaseWorkerModule(directory: string): string {
  const candidates = [
    resolve(directory, "../../db/local.js"),
    resolve(directory, "src/db/local.js"),
    resolve(findLocalPackageRoot(directory), "dist/src/db/local.js"),
  ];
  const filename = candidates.find((candidate) => existsSync(candidate));
  if (!filename)
    throw new Error("Database worker module is unavailable; build the shared package first");
  return filename;
}
