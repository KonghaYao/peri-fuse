import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyLocalMigrations,
  createLocalDatabase,
  type LocalDatabase,
  readLocalMigrations,
  resolveDatabaseConfig,
} from "@peri-fuse/shared/src/db/local";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import * as schema from "./db/schema.js";

export type Db = ReturnType<typeof createDb>;
function createDb(client: LocalDatabase) {
  return drizzle({ client, relations: schema.databaseRelations });
}
let client: LocalDatabase | null = null;
let database: Db | null = null;
let ready: Promise<void> | null = null;

export function getDb(): Db {
  if (!database) {
    const config = resolveDatabaseConfig("gateway", "file:./.peri-fuse/gateway.turso.db");
    client = createLocalDatabase(config.url, false, config.authToken);
    database = createDb(client);
  }
  return database;
}

function findMigrationDirectory(): string {
  const candidates = [
    path.resolve(__dirname, "drizzle"),
    path.resolve(__dirname, "../../drizzle"),
    path.resolve(__dirname, "../drizzle"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error("Gateway migration SQL directory not found");
}

export function ensureSchema(): Promise<void> {
  if (!ready) {
    getDb();
    ready = applyLocalMigrations(client!, readLocalMigrations(findMigrationDirectory()));
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
