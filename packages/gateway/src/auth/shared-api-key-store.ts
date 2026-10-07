import {
  createLocalDatabase,
  initializeLocalDatabase,
  isRemoteDatabaseUrl,
  type LocalDatabase,
  localFileExists,
  resolveDatabaseConfig,
} from "@peri-fuse/shared/src/db/local";

let sharedDb: LocalDatabase | null = null;
let ready: Promise<LocalDatabase> | null = null;

export function getSharedApiKeyDb(): Promise<LocalDatabase> {
  if (!ready) {
    const config = resolveDatabaseConfig("metadata", "file:./.langfuse/langfuse.turso.db");
    if (!isRemoteDatabaseUrl(config.url) && !localFileExists(config.url))
      return Promise.reject(
        new Error("Shared API-key database does not exist; start the server first"),
      );
    sharedDb = createLocalDatabase(config.url, false, config.authToken);
    const database = sharedDb;
    ready = initializeLocalDatabase(database).then(async () => {
      const marker = await database.get(
        "SELECT name FROM sqlite_master WHERE name='_perifuse_migrations'",
      );
      if (!marker)
        throw new Error("Legacy shared database is unsupported; select a new database path");
      return database;
    });
  }
  return ready;
}

export async function projectApiKeyExists(publicKey: string, projectId: string): Promise<boolean> {
  const db = await getSharedApiKeyDb();
  const row = await db.get(
    "SELECT 1 FROM api_keys WHERE public_key=? AND project_id=? AND scope='PROJECT' LIMIT 1",
    publicKey,
    projectId,
  );
  return row !== undefined;
}

export async function closeSharedApiKeyDb(): Promise<void> {
  await ready?.catch(() => undefined);
  await sharedDb?.close();
  ready = null;
  sharedDb = null;
}
