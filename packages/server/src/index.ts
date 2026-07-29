/**
 * Lite server entrypoint.
 *
 * IMPORTANT: `./env` must be the first import — it forces LANGFUSE_MODE=lite
 * and SQLite defaults before `@langfuse-lite/shared` reads and caches the mode.
 */
import "./env";

import { serve } from "@hono/node-server";
import { logger } from "@langfuse-lite/shared/src/server";
import { createApp } from "./app";
import { liteEnv } from "./env";

const app = createApp();

serve({ fetch: app.fetch, port: liteEnv.port }, (info) => {
  logger.info(
    `[lite-server] Langfuse lite server listening on http://localhost:${info.port} (mode=${process.env.LANGFUSE_MODE})`,
  );
});
