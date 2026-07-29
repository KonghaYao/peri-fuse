import { defineConfig } from "vitest/config";
import { TEST_AUTH_DB, TEST_SALT, TEST_TELEMETRY_DB } from "./src/__tests__/test-db-paths";

export default defineConfig({
  test: {
    dir: "./src",
    pool: "forks",
    // Test files share one SQLite database; run them sequentially to avoid
    // write contention.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: "./src/__tests__/global-setup.ts",
    // Point every worker at the throwaway test databases (see global-setup).
    env: {
      LANGFUSE_MODE: "lite",
      DATABASE_URL: `file:${TEST_AUTH_DB}`,
      LANGFUSE_SQLITE_DB_PATH: TEST_TELEMETRY_DB,
      SALT: TEST_SALT,
    },
    server: {
      deps: {
        inline: ["@peri-fuse/shared"],
      },
    },
  },
});
