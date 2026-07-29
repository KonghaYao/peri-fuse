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
import * as path from "node:path";

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

const projectRoot = findProjectRoot();

// Force lite mode unless the caller explicitly chose otherwise.
if (!process.env.LANGFUSE_MODE) {
  process.env.LANGFUSE_MODE = "lite";
}

// Prisma SQLite database. Defaults to <project-root>/.langfuse/langfuse.db.
if (process.env.DATABASE_URL?.startsWith("file:")) {
  const rawPath = process.env.DATABASE_URL.slice("file:".length);
  if (!path.isAbsolute(rawPath)) {
    process.env.DATABASE_URL = `file:${path.resolve(projectRoot, rawPath)}`;
  }
} else if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${path.join(projectRoot, ".langfuse", "langfuse.db")}`;
}

// Telemetry storage defaults to the local SQLite file.
if (!process.env.LANGFUSE_SQLITE_DB_PATH) {
  process.env.LANGFUSE_SQLITE_DB_PATH = path.join(projectRoot, ".langfuse", "telemetry.db");
}

// SALT for API key hashing. Auto-generate a stable one if not provided.
if (!process.env.SALT) {
  const saltFile = path.join(projectRoot, ".langfuse", ".salt");
  const saltDir = path.dirname(saltFile);
  if (!fs.existsSync(saltDir)) {
    fs.mkdirSync(saltDir, { recursive: true });
  }
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
