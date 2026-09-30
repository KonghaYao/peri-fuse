import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    env: { LANGFUSE_MODE: "lite" },
    silent: "passed-only",
    dir: "./src",
    include: ["**/*.test.ts"],
    // The root test command runs these with fresh databases via test:ingestion.
    exclude: [
      ...configDefaults.exclude,
      "**/*-isolated.test.ts",
      "**/adapters/io-compression.test.ts",
      "**/ingestion/lite-reliability.test.ts",
    ],
    pool: "forks",
    server: {
      deps: {
        // Process the Vertex provider through vite so vi.mock can replace its
        // google-auth-library import (externalized deps bypass the mock
        // registry) — required by the AI SDK request-shape tests.
        inline: ["@ai-sdk/google-vertex"],
      },
    },
  },
});
