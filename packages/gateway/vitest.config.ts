import { defineConfig } from "vitest/config";

for (const name of Object.keys(process.env)) {
  if (name.startsWith("TURSO_")) delete process.env[name];
}

export default defineConfig({
  envDir: false,
  test: {
    dir: "./test",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      GATEWAY_DB_URL: "file:/tmp/peri-gateway-test.db",
      GATEWAY_ENCRYPTION_KEY: "a".repeat(64),
      GATEWAY_LOG_REQUESTS: "true",
      GATEWAY_FLUSH_INTERVAL_MS: "500",
      GATEWAY_DAILY_FLUSH_INTERVAL_MS: "500",
    },
  },
});
