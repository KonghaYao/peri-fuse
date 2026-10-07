import * as path from "node:path";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import {
  applyLocalMigrations,
  createLocalDatabase,
  findLocalPackageRoot,
  type LocalDatabase,
  readLocalMigrations,
  resolveDatabaseConfig,
} from "./local.js";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;
function createDb(client: LocalDatabase) {
  return drizzle({ client, relations: schema.databaseRelations });
}
let client: LocalDatabase | null = null;
let database: Db | null = null;
let ready: Promise<void> | null = null;

export function getDb(): Db {
  if (!database) {
    const config = resolveDatabaseConfig("metadata", "file:./.langfuse/langfuse.turso.db");
    client = createLocalDatabase(config.url, false, config.authToken);
    database = createDb(client);
  }
  return database;
}

export function ensureSchema(): Promise<void> {
  if (!ready) {
    getDb();
    const directory = path.join(findLocalPackageRoot(__dirname), "drizzle");
    const migrations = readLocalMigrations(directory);
    ready = applyLocalMigrations(client!, migrations);
  }
  return ready;
}

export async function closeDb(): Promise<void> {
  await ready?.catch(() => undefined);
  await client?.close();
  client = null;
  database = null;
  ready = null;
}
