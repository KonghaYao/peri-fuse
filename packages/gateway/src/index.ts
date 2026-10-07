/**
 * PeriGateway standalone entrypoint (dev-only).
 *
 * In production the gateway routes and services are embedded in the main
 * server (@peri-fuse/server) — see packages/server/src/app.ts and index.ts.
 * This file remains for local development / debugging of the gateway in
 * isolation (pnpm --filter @peri/gateway dev).
 */
import "./env.js";

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { closeDb, ensureSchema } from "./db.js";
import { gatewayEnv } from "./env.js";
import { startGatewayServices, stopGatewayServices } from "./services.js";

const app = createApp();
let server: ReturnType<typeof serve>;
let shuttingDown = false;

async function main() {
  // Ensure database connection and create tables on first boot (WAL + busy_timeout
  // pragmas are applied when the connection opens in db.ts).
  await ensureSchema();

  // Start background services
  startGatewayServices();

  server = serve({ fetch: app.fetch, port: gatewayEnv.port }, (info) => {
    console.log(`[peri-gateway] Listening on http://localhost:${info.port}`);
    console.log(`[peri-gateway] Database: ${gatewayEnv.dbUrl}`);
    console.log(`[peri-gateway] Auth: project-scoped API keys (via shared server DB)`);
  });
}

// Graceful shutdown
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[peri-gateway] Shutting down...");
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

  // Stop background services and flush remaining spend data
  try {
    await stopGatewayServices();
    console.log("[peri-gateway] Spend data flushed.");
  } catch (err) {
    console.error("[peri-gateway] Flush error on shutdown:", err);
  }

  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

// Force exit after 5s if graceful shutdown hangs
process.on("SIGINT", () => setTimeout(() => process.exit(1), 5000).unref());
process.on("SIGTERM", () => setTimeout(() => process.exit(1), 5000).unref());

main().catch((err) => {
  console.error("[peri-gateway] Fatal startup error:", err);
  process.exit(1);
});
