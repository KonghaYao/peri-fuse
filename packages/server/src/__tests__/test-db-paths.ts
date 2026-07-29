/**
 * Shared constants for the lite-server integration test suite.
 *
 * The suite runs against throwaway SQLite databases under `.test/` so it
 * never touches the developer's `.langfuse/` databases.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** packages/lite-server/.test */
export const TEST_DB_DIR = path.resolve(here, "..", "..", ".test");
/** Prisma (auth) database used by the tests. */
export const TEST_AUTH_DB = path.join(TEST_DB_DIR, "langfuse-test.db");
/** Telemetry database used by the tests. */
export const TEST_TELEMETRY_DB = path.join(TEST_DB_DIR, "telemetry-test.db");

export const TEST_SALT = "lite-server-test-salt";

export const TEST_ORG_ID = "test-org-lite-server";
export const TEST_PROJECT_ID = "test-project-lite-server";
export const TEST_PUBLIC_KEY = "pk-lf-test-lite-server";
export const TEST_SECRET_KEY = "sk-lf-test-lite-server-secret";
