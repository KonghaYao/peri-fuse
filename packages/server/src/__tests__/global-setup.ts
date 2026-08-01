/**
 * Vitest global setup for the lite-server integration suite.
 *
 * Runs once before all test files:
 *   1. Recreates a throwaway `.test/` directory with fresh SQLite databases.
 *   2. Applies the Drizzle schema (CREATE TABLE) to the auth database.
 *   3. Seeds an org + project + API key so the auth middleware can verify.
 *
 * Test workers receive matching env vars via `test.env` in vitest.config.ts.
 */
import * as fs from "node:fs";
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

  // Create all metadata tables in the fresh auth database (Drizzle migration
  // SQL; replaces the previous `prisma db push`).
  const { ensureSchema, closeDb } = await import("@peri-fuse/shared/src/db");
  ensureSchema();

  // Seed auth data through the Drizzle client (schema is applied at this point).
  const { prisma } = await import("@peri-fuse/shared/src/db");
  const {
    organizations,
    projects,
    apiKeys,
  } = await import("@peri-fuse/shared/src/db/schema/index.js");
  const { hashSecretKey, createShaHash } = await import("@peri-fuse/shared/src/server");

  await prisma.insert(organizations).values({
    id: TEST_ORG_ID,
    name: "Lite Server Test Org",
  });
  await prisma.insert(projects).values({
    id: TEST_PROJECT_ID,
    orgId: TEST_ORG_ID,
    name: "Lite Server Test",
  });
  await prisma.insert(apiKeys).values({
    id: crypto.randomUUID(),
    publicKey: TEST_PUBLIC_KEY,
    hashedSecretKey: await hashSecretKey(TEST_SECRET_KEY),
    fastHashedSecretKey: createShaHash(TEST_SECRET_KEY, TEST_SALT),
    displaySecretKey: `${TEST_SECRET_KEY.slice(0, 10)}...`,
    projectId: TEST_PROJECT_ID,
    organizationId: TEST_ORG_ID,
    scope: "PROJECT",
  });

  closeDb();
}
