/**
 * PeriGateway entrypoint.
 */
import "./env.js";

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { closeDb, ensureSchema } from "./db.js";
import { gatewayEnv } from "./env.js";
import { spendFlusher } from "./spend/flusher.js";
import { startBudgetReset, stopBudgetReset } from "./spend/budget-reset.js";
import { startCooldownRecovery, stopCooldownRecovery } from "./router/cooldown.js";

const app = createApp();

async function main() {
  // Ensure database connection and create tables on first boot (WAL + busy_timeout
  // pragmas are applied when the connection opens in db.ts).
  ensureSchema();

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

  closeDb();
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
