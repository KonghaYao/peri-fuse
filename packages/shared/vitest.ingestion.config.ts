import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    include: [
      "src/server/repositories/lite-queries.test.ts",
      "src/server/repositories/observations-pagination.test.ts",
      "src/server/otel/*.test.ts",
      "src/server/adapters/telemetry-query-context.test.ts",
      "src/server/adapters/sqlite-search-availability.test.ts",
      "src/server/stats/reliability-isolated.test.ts",
      "src/server/repositories/io-read-isolated.test.ts",
      "src/server/session-search/*.test.ts",
      "src/server/adapters/sqlite-read-pool.test.ts",
      "src/server/stats/background-maintenance.test.ts",
      "src/server/stats/maintenance-loop.test.ts",
      "src/server/adapters/io-compression.test.ts",
      "src/server/ingestion/lite-reliability.test.ts",
      "src/server/ingestion/processEventBatchLite.test.ts",
      "../server/src/__tests__/io-api-isolated.test.ts",
      "../server/src/__tests__/otel-persistence.test.ts",
      "../server/src/__tests__/ingestion-http-isolated.test.ts",
    ],
    pool: "forks",
  },
});
