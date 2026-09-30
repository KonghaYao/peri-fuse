import { configDefaults, defineConfig } from "vitest/config";
import {
  TEST_AUTH_DB,
  TEST_DB_DIR,
  TEST_GATEWAY_DB,
  TEST_SALT,
  TEST_TELEMETRY_DB,
} from "./src/__tests__/test-db-paths";

export default defineConfig({
  envDir: false,
  test: {
    dir: "./src",
    // These suites require the separate test:ingestion environment, not globalSetup.
    exclude: [...configDefaults.exclude, "**/*-isolated.test.ts"],
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
      PERIFUSE_HOME: TEST_DB_DIR,
      DATABASE_URL: `file:${TEST_AUTH_DB}`,
      LANGFUSE_SQLITE_DB_PATH: TEST_TELEMETRY_DB,
      GATEWAY_DB_URL: `file:${TEST_GATEWAY_DB}`,
      PERIFUSE_IO_COMPRESSION_WRITE: "off",
      SALT: TEST_SALT,
    },
    server: {
      deps: {
        inline: ["@peri-fuse/shared"],
      },
    },
  },
});
