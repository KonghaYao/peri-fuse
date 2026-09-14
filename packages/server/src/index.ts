/**
 * Lite server entrypoint.
 *
 * IMPORTANT: `./env` must be the first import — it forces LANGFUSE_MODE=lite
 * and SQLite defaults before `@peri-fuse/shared` reads and caches the mode.
 */
import "./env";

import { serve } from "@hono/node-server";
import { startGatewayServices, stopGatewayServices } from "@peri/gateway/services";
import { logger } from "@peri-fuse/shared/src/server";
import { getTelemetryDB, SQLiteTelemetryAdapter } from "@peri-fuse/shared/src/server/adapters";
import { stopSessionSearchReadPool } from "@peri-fuse/shared/src/server/session-search";
import { SessionSearchLifecycle } from "@peri-fuse/shared/src/server/session-search/lifecycle";
import { startDailyStatsMaintenance } from "@peri-fuse/shared/src/server/stats/daily-stats";
import { startRetentionJob } from "@peri-fuse/shared/src/server/stats/retention";
import { createApp } from "./app";
import { ensureBootstrap } from "./bootstrap";
import { ensurePrismaSchema } from "./db-init";
import { liteEnv } from "./env";
import { ensureGatewaySchema, migrateOrphanedGatewayData } from "./gateway-init";

// Auto-create metadata tables on first boot (no manual migration needed)
ensurePrismaSchema();

// Auto-create gateway tables on first boot (no manual migration needed)
ensureGatewaySchema();

// Start gateway background services (spend flusher, budget reset, cooldown recovery)
startGatewayServices();

// Dashboard rollup maintenance (backfill missing days + refresh recent days)
const stopStatsMaintenance = startDailyStatsMaintenance();
// Optional retention purge (PERIFUSE_TELEMETRY_RETENTION_DAYS; off by default)
const stopRetentionJob = startRetentionJob();
const telemetryAdapter = getTelemetryDB();
const sessionSearch =
  telemetryAdapter instanceof SQLiteTelemetryAdapter
    ? new SessionSearchLifecycle(telemetryAdapter.getDatabase())
    : undefined;
sessionSearch?.start();

const app = createApp();

const server = serve({ fetch: app.fetch, port: liteEnv.port }, (info) => {
  logger.info(
    `[lite-server] Peri-Fuse server listening on http://localhost:${info.port} (mode=${process.env.LANGFUSE_MODE})`,
  );
});

async function main() {
  // Create default org/project/API key if database is empty
  await ensureBootstrap();
  // Assign pre-project-scoping gateway rows (empty projectId) to the oldest project
  await migrateOrphanedGatewayData();
}

main().catch((err) => {
  logger.error("[lite-server] Fatal startup error", err);
  process.exit(1);
});

// Graceful shutdown — close HTTP server and SQLite connections so tsx watch can restart cleanly
async function shutdown() {
  server.close();
  stopStatsMaintenance();
  stopRetentionJob();
  await sessionSearch?.stop();
  await stopSessionSearchReadPool(telemetryAdapter);
  try {
    await stopGatewayServices();
  } catch {
    /* ignore */
  }
  try {
    const { closeDb } = await import("@peri-fuse/shared/src/db");
    closeDb();
  } catch {
    /* ignore */
  }
  try {
    const { closeDb } = await import("@peri/gateway/db");
    closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
