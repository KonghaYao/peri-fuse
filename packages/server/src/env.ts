/**
 * Environment bootstrap for the Lite server.
 *
 * This module MUST be imported before anything that pulls in
 * `@peri-fuse/shared`, because the shared adapter factory reads
 * `LANGFUSE_MODE` once and caches it. We force lite mode and provide
 * SQLite defaults so the server runs with zero external services.
 */
/* eslint-disable turbo/no-undeclared-env-vars -- runtime env bootstrap, not a build input */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Global data directory. All persistent state (SQLite databases, salt) lives
 * here so it is shared across checkouts and independent of the repo location.
 * Override with PERIFUSE_HOME. Defaults to ~/.peri-fuse.
 */
function dataDir(): string {
  return process.env.PERIFUSE_HOME || path.join(os.homedir(), ".peri-fuse");
}

function ensureDataDir(): string {
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Force lite mode unless the caller explicitly chose otherwise.
if (!process.env.LANGFUSE_MODE) {
  process.env.LANGFUSE_MODE = "lite";
}

// Prisma SQLite database. Defaults to ~/.peri-fuse/langfuse.db.
if (process.env.DATABASE_URL?.startsWith("file:")) {
  const rawPath = process.env.DATABASE_URL.slice("file:".length);
  if (!path.isAbsolute(rawPath)) {
    process.env.DATABASE_URL = `file:${path.resolve(process.cwd(), rawPath)}`;
  }
} else if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${path.join(ensureDataDir(), "langfuse.db")}`;
}

// Telemetry storage defaults to the local SQLite file in the global data dir.
if (!process.env.LANGFUSE_SQLITE_DB_PATH) {
  process.env.LANGFUSE_SQLITE_DB_PATH = path.join(ensureDataDir(), "telemetry.db");
}

// SALT for API key hashing. Auto-generate a stable one if not provided.
if (!process.env.SALT) {
  const saltFile = path.join(ensureDataDir(), ".salt");
  if (fs.existsSync(saltFile)) {
    process.env.SALT = fs.readFileSync(saltFile, "utf8").trim();
  } else {
    const { randomBytes } = require("node:crypto");
    const salt = randomBytes(32).toString("hex");
    fs.writeFileSync(saltFile, salt, "utf8");
    process.env.SALT = salt;
  }
}

export const liteEnv = {
  port: process.env.LITE_SERVER_PORT ? parseInt(process.env.LITE_SERVER_PORT, 10) : 23332,
  salt: process.env.SALT,
};
