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
import { ensureGatewaySchema } from "./gateway-init";

// Dashboard rollup maintenance (backfill missing days + refresh recent days)
let stopStatsMaintenance = async () => {};
// Optional retention purge (PERIFUSE_TELEMETRY_RETENTION_DAYS; off by default)
let stopRetentionJob = async () => {};
const telemetryAdapter = getTelemetryDB();
const sessionSearch =
  telemetryAdapter instanceof SQLiteTelemetryAdapter
    ? new SessionSearchLifecycle(telemetryAdapter.getDatabase())
    : undefined;

const app = createApp();

let server: ReturnType<typeof serve> | undefined;
let shuttingDown = false;

async function main() {
  await ensurePrismaSchema();
  await ensureGatewaySchema();
  if (telemetryAdapter instanceof SQLiteTelemetryAdapter) await telemetryAdapter.initialize();
  // Create default org/project/API key if database is empty
  await ensureBootstrap();
  startGatewayServices();
  stopStatsMaintenance = startDailyStatsMaintenance();
  stopRetentionJob = startRetentionJob();
  sessionSearch?.start();
  server = serve({ fetch: app.fetch, port: liteEnv.port }, (info) => {
    logger.info(
      `[lite-server] Peri-Fuse server listening on http://localhost:${info.port} (mode=${process.env.LANGFUSE_MODE})`,
    );
  });
}

main().catch((err) => {
  logger.error("[lite-server] Fatal startup error", err);
  process.exit(1);
});

// Graceful shutdown — close HTTP server and SQLite connections so tsx watch can restart cleanly
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
  await app.close();
  await Promise.all([stopStatsMaintenance(), stopRetentionJob()]);
  await sessionSearch?.stop();
  await stopSessionSearchReadPool(telemetryAdapter);
  try {
    await stopGatewayServices();
  } catch {
    /* ignore */
  }
  try {
    const { closeDb } = await import("@peri-fuse/shared/src/db");
    await closeDb();
  } catch {
    /* ignore */
  }
  try {
    const { closeDb } = await import("@peri/gateway/db");
    await closeDb();
  } catch {
    /* ignore */
  }
  await telemetryAdapter.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
