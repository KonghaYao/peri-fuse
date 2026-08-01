/**
 * Lite server entrypoint.
 *
 * IMPORTANT: `./env` must be the first import — it forces LANGFUSE_MODE=lite
 * and SQLite defaults before `@peri-fuse/shared` reads and caches the mode.
 */
import "./env";

import { serve } from "@hono/node-server";
import { logger } from "@peri-fuse/shared/src/server";
import { createApp } from "./app";
import { ensureBootstrap } from "./bootstrap";
import { ensurePrismaSchema } from "./db-init";
import { liteEnv } from "./env";

// Auto-create Prisma tables on first boot (no manual db:push needed)
ensurePrismaSchema();

const app = createApp();

const server = serve({ fetch: app.fetch, port: liteEnv.port }, (info) => {
  logger.info(
    `[lite-server] Peri-Fuse server listening on http://localhost:${info.port} (mode=${process.env.LANGFUSE_MODE})`,
  );
});

async function main() {
  // Create default org/project/API key if database is empty
  await ensureBootstrap();
}

main().catch((err) => {
  logger.error("[lite-server] Fatal startup error", err);
  process.exit(1);
});

// Graceful shutdown — close HTTP server and Prisma connections so tsx watch can restart cleanly
async function shutdown() {
  server.close();
  try {
    const { prisma } = await import("@peri-fuse/shared/src/db");
    await prisma.$disconnect();
  } catch { /* ignore */ }
  try {
    const { getDb } = await import("@peri/gateway/db");
    await getDb().$disconnect();
  } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
