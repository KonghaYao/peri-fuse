import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "./test",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      GATEWAY_DB_URL: "file:/tmp/peri-gateway-test.db",
      GATEWAY_ADMIN_KEY: "test-admin-key",
      GATEWAY_ENCRYPTION_KEY: "a".repeat(64),
      GATEWAY_LOG_REQUESTS: "true",
      GATEWAY_FLUSH_INTERVAL_MS: "500",
      GATEWAY_DAILY_FLUSH_INTERVAL_MS: "500",
    },
  },
});
