/**
 * Auto-initialize the Gateway SQLite database on first boot.
 *
 * Mirrors db-init.ts: the gateway has no migration step of its own, so when
 * its database file is empty (fresh install) we shell out to `prisma db push`
 * using the gateway schema. Subsequent boots skip this entirely.
 *
 * Must run after `./env` (which sets the default GATEWAY_DB_URL) and before
 * any gateway admin route touches the database.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@peri-fuse/shared/src/server";
// Side-effect: sets the default GATEWAY_DB_URL (and encryption key) before we
// read it below. Importing the module runs the gateway env bootstrap once.
import "@peri/gateway/env";

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

/** Returns true if the gateway database already has tables (schema pushed). */
function isDbInitialized(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Provider'")
      .get();
    db.close();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Ensure the gateway database schema is up to date.
 * Call once at server startup before handling gateway admin requests.
 */
export function ensureGatewaySchema(): void {
  const dbUrl = process.env.GATEWAY_DB_URL ?? "";
  if (!dbUrl.startsWith("file:")) {
    // Non-SQLite — skip auto-push
    return;
  }

  const dbPath = dbUrl.slice("file:".length);
  const absDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);

  if (isDbInitialized(absDbPath)) {
    return;
  }

  logger.info("[gateway-init] Gateway database not initialized — pushing schema…");

  const projectRoot = findProjectRoot();
  const gatewayDir = path.join(projectRoot, "packages", "gateway");
  const schemaPath = path.join(gatewayDir, "prisma", "schema.prisma");

  const dbDir = path.dirname(absDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  try {
    execFileSync(
      "pnpm",
      ["exec", "prisma", "db", "push", `--schema=${schemaPath}`, "--accept-data-loss"],
      {
        // Run from the gateway package so `pnpm exec` resolves its prisma dep.
        cwd: gatewayDir,
        env: { ...process.env, GATEWAY_DB_URL: `file:${absDbPath}` },
        stdio: "pipe",
        timeout: 30_000,
      },
    );
    logger.info("[gateway-init] Gateway schema pushed successfully.");
  } catch (error) {
    const msg =
      error instanceof Error ? ((error as any).stderr?.toString() ?? error.message) : String(error);
    logger.error(`[gateway-init] Failed to push gateway schema: ${msg}`);
    throw new Error(`Gateway database initialization failed: ${msg}`);
  }
}
