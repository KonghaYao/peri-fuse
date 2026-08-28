import { resolve } from "node:path";
import Database from "better-sqlite3";

let sharedDb: Database.Database | null = null;

/**
 * Return the lazily opened, process-lifetime connection to the server's shared API-key database.
 * Gateway auth reads key records through this handle and may backfill only its fast-hash column;
 * project-ownership checks remain read-only and must not mutate shared key identity or scope.
 */
export function getSharedApiKeyDb(): Database.Database {
  if (sharedDb) return sharedDb;

  const rawUrl = process.env.DATABASE_URL ?? "file:./.langfuse/langfuse.db";
  let dbPath: string;
  if (rawUrl.startsWith("file:")) {
    const rawPath = rawUrl.slice("file:".length);
    dbPath = rawPath.startsWith("/") ? rawPath : resolve(process.cwd(), rawPath);
  } else {
    dbPath = rawUrl;
  }

  sharedDb = new Database(dbPath, { readonly: false });
  sharedDb.pragma("busy_timeout = 5000");
  return sharedDb;
}

/**
 * Read whether a public key is owned by the requested project and has PROJECT scope.
 * Missing keys, keys owned by another project, and organization-scoped keys are deliberately
 * indistinguishable so Admin callers cannot discover another project's key inventory.
 */
export function projectApiKeyExists(publicKey: string, projectId: string): boolean {
  const row = getSharedApiKeyDb()
    .prepare(
      `SELECT 1
       FROM api_keys
       WHERE public_key = ? AND project_id = ? AND scope = 'PROJECT'
       LIMIT 1`,
    )
    .get(publicKey, projectId);
  return row !== undefined;
}
