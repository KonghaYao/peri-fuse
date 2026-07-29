/**
 * Auto-initialize the Prisma (auth/metadata) SQLite database on first boot.
 *
 * If the `api_keys` table does not exist, we shell out to `prisma db push`
 * to create the full schema. Subsequent boots skip this entirely.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@peri-fuse/shared/src/server";

function findProjectRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * Returns true if the Prisma database already has tables (i.e. schema was pushed).
 */
function isDbInitialized(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    // Use better-sqlite3 to check for table existence (already a dependency)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
      .get();
    db.close();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Ensure the Prisma database schema is up to date.
 * Call this once at server startup before handling requests.
 */
export function ensurePrismaSchema(): void {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.startsWith("file:")) {
    // Non-SQLite (full mode) — skip auto-push
    return;
  }

  const dbPath = dbUrl.slice("file:".length);
  const absDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);

  if (isDbInitialized(absDbPath)) {
    return;
  }

  logger.info("[db-init] Prisma database not initialized — pushing schema…");

  const projectRoot = findProjectRoot();
  const schemaPath = path.join(projectRoot, "packages", "shared", "prisma", "schema.sqlite.prisma");

  // Ensure the directory for the DB file exists
  const dbDir = path.dirname(absDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  try {
    execFileSync(
      "pnpm",
      ["exec", "prisma", "db", "push", `--schema=${schemaPath}`, "--accept-data-loss"],
      {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: `file:${absDbPath}` },
        stdio: "pipe",
        timeout: 30_000,
      },
    );
    logger.info("[db-init] Schema pushed successfully.");
  } catch (error) {
    const msg =
      error instanceof Error ? ((error as any).stderr?.toString() ?? error.message) : String(error);
    logger.error(`[db-init] Failed to push schema: ${msg}`);
    throw new Error(`Database initialization failed: ${msg}`);
  }
}
