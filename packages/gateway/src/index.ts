/**
 * PeriGateway entrypoint.
 */
import "./env.js";

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getDb } from "./db.js";
import { gatewayEnv } from "./env.js";
import { spendFlusher } from "./spend/flusher.js";
import { startBudgetReset, stopBudgetReset } from "./spend/budget-reset.js";
import { startCooldownRecovery, stopCooldownRecovery } from "./router/cooldown.js";

const app = createApp();

async function main() {
  // Ensure database connection
  const db = getDb();
  await db.$connect();

  // Enable WAL mode for better concurrent read/write
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
  await db.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");

  // Start background services
  spendFlusher.start();
  startBudgetReset();
  startCooldownRecovery();

  serve({ fetch: app.fetch, port: gatewayEnv.port }, (info) => {
    console.log(
      `[peri-gateway] Listening on http://localhost:${info.port}`,
    );
    console.log(`[peri-gateway] Database: ${gatewayEnv.dbUrl}`);
    console.log(`[peri-gateway] Admin key: ${gatewayEnv.adminKey.slice(0, 8)}...`);
  });
}

// Graceful shutdown
async function shutdown() {
  console.log("[peri-gateway] Shutting down...");

  // Stop background services
  spendFlusher.stop();
  stopBudgetReset();
  stopCooldownRecovery();

  // Flush remaining spend data
  try {
    await spendFlusher.flushAll();
    console.log("[peri-gateway] Spend data flushed.");
  } catch (err) {
    console.error("[peri-gateway] Flush error on shutdown:", err);
  }

  const db = getDb();
  await db.$disconnect().catch(() => {});
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
