import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database, type Transaction } from "@tursodatabase/database";
import { isRemoteDatabaseUrl, validateDatabaseConfig } from "./connection-config";
import { createRemoteDatabase } from "./remote";

export {
  isRemoteDatabaseUrl,
  resolveDatabaseConfig,
  validateDatabaseConfig,
} from "./connection-config";
export { getRemoteDatabaseConfig } from "./remote";

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
  const config = validateDatabaseConfig({ url, authToken });
  if (isRemoteDatabaseUrl(config.url)) return createRemoteDatabase(config, readonly);
  url = config.url;
  const filename = resolveLocalPath(url);
  if (filename !== ":memory:" && !readonly) mkdirSync(dirname(filename), { recursive: true });
  return new Database(filename, {
    ...(filename === ":memory:" ? {} : LOCAL_DATABASE_OPTIONS),
    readonly,
    fileMustExist: readonly,
    timeout: 5000,
  });
}

export async function initializeLocalDatabase(db: Database): Promise<void> {
  await db.connect();
  await db.exec("PRAGMA foreign_keys = ON");
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

export async function applyLocalMigrations(
  db: Database,
  migrations: { name: string; sql: string }[],
): Promise<void> {
  await initializeLocalDatabase(db);
  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) as { name: string }[];
  if (tables.length && !tables.some((table) => table.name === "_perifuse_migrations")) {
    throw new Error(
      "Existing legacy database is not supported. Select a new database path; the old database is not migrated or deleted.",
    );
  }
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _perifuse_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
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
