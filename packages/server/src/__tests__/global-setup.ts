/**
 * Vitest global setup for the lite-server integration suite.
 *
 * Runs once before all test files:
 *   1. Recreates a throwaway `.test/` directory with fresh SQLite databases.
 *   2. Pushes the Prisma SQLite schema into the auth database.
 *   3. Seeds an org + project + API key so the auth middleware can verify.
 *
 * Test workers receive matching env vars via `test.env` in vitest.config.ts.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TEST_AUTH_DB,
  TEST_DB_DIR,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  TEST_PUBLIC_KEY,
  TEST_SALT,
  TEST_SECRET_KEY,
  TEST_TELEMETRY_DB,
} from "./test-db-paths";

export default async function setup(): Promise<void> {
  // Point the shared package at the throwaway databases BEFORE importing it.
  process.env.LANGFUSE_MODE = "lite";
  process.env.DATABASE_URL = `file:${TEST_AUTH_DB}`;
  process.env.LANGFUSE_SQLITE_DB_PATH = TEST_TELEMETRY_DB;
  process.env.SALT = TEST_SALT;

  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });

  // packages/lite-server/.test -> monorepo root
  const repoRoot = path.resolve(TEST_DB_DIR, "..", "..", "..");
  const schemaPath = path.join(repoRoot, "packages", "shared", "prisma", "schema.sqlite.prisma");

  // Resolve the workspace-local prisma CLI (avoid npx which may pick up a
  // global / parent-workspace Prisma 7+ that rejects `url` in schema files).
  const prismaBin = path.join(
    repoRoot,
    "node_modules",
    ".pnpm",
    "prisma@6.19.3_typescript@5.9.3",
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );

  execFileSync(
    process.execPath,
    [prismaBin, "db", "push", `--schema=${schemaPath}`, "--accept-data-loss"],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: `file:${TEST_AUTH_DB}` },
    },
  );

  // Seed auth data through the Prisma client (schema is pushed at this point).
  const { prisma } = await import("@peri-fuse/shared/src/db");
  const { hashSecretKey, createShaHash } = await import("@peri-fuse/shared/src/server");

  await prisma.organization.create({
    data: { id: TEST_ORG_ID, name: "Lite Server Test Org" },
  });
  await prisma.project.create({
    data: { id: TEST_PROJECT_ID, orgId: TEST_ORG_ID, name: "Lite Server Test" },
  });
  await prisma.apiKey.create({
    data: {
      publicKey: TEST_PUBLIC_KEY,
      hashedSecretKey: await hashSecretKey(TEST_SECRET_KEY),
      fastHashedSecretKey: createShaHash(TEST_SECRET_KEY, TEST_SALT),
      displaySecretKey: `${TEST_SECRET_KEY.slice(0, 10)}...`,
      projectId: TEST_PROJECT_ID,
      orgId: TEST_ORG_ID,
      scope: "PROJECT",
    },
  });

  await prisma.$disconnect();
}
