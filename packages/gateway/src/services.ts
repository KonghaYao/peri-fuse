/**
 * Gateway background services lifecycle — exported for embedding in the main
 * server process. The standalone gateway entrypoint (index.ts) also uses these.
 */

import { startCooldownRecovery, stopCooldownRecovery } from "./router/cooldown.js";
import { startBudgetReset, stopBudgetReset } from "./spend/budget-reset.js";
import { spendFlusher } from "./spend/flusher.js";

/**
 * Start all gateway background services (spend flusher, budget reset timer,
 * cooldown recovery). Call once after ensureSchema() at server boot.
 */
export function startGatewayServices(): void {
  spendFlusher.start();
  startBudgetReset();
  startCooldownRecovery();
}

/**
 * Gracefully stop all gateway background services and flush remaining spend
 * data. Call during server shutdown before closing the database.
 */
export async function stopGatewayServices(): Promise<void> {
  spendFlusher.stop();
  stopBudgetReset();
  stopCooldownRecovery();
  await spendFlusher.flushAll();
}
