/**
 * Auto-initialize the Gateway SQLite database on first boot.
 *
 * Mirrors db-init.ts: the gateway has no migration step of its own, so when
 * its database file is empty (fresh install) we apply the committed drizzle
 * migration SQL via the gateway's own `ensureSchema()`. Subsequent boots skip
 * this entirely.
 *
 * Must run after `./env` (which sets the default GATEWAY_DB_URL) and before
 * any gateway admin route touches the database.
 */
import { logger } from "@peri-fuse/shared/src/server";
// Side-effect: sets the default GATEWAY_DB_URL (and encryption key) before we
// read it below. Importing the module runs the gateway env bootstrap once.
import "@peri/gateway/env";
import { ensureSchema } from "@peri/gateway/db";

/**
 * Ensure the gateway database schema is up to date.
 * Call once at server startup before handling gateway admin requests.
 */
export function ensureGatewaySchema(): void {
  const dbUrl = process.env.GATEWAY_DB_URL ?? "";
  if (!dbUrl.startsWith("file:")) {
    // Non-SQLite — nothing to auto-create.
    return;
  }

  try {
    ensureSchema();
    logger.info("[gateway-init] Gateway schema ready.");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[gateway-init] Failed to initialize gateway schema: ${msg}`);
    throw new Error(`Gateway database initialization failed: ${msg}`);
  }
}
