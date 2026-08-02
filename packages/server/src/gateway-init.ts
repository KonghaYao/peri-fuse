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
import { ensureSchema, getDb } from "@peri/gateway/db";
import { prisma } from "@peri-fuse/shared/src/db";
import { projects } from "@peri-fuse/shared/src/db/schema/index.js";
import { asc, sql } from "drizzle-orm";

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

/**
 * Gateway tables that carry a projectId column and therefore may hold orphaned
 * rows created before project scoping was introduced.
 */
const GATEWAY_PROJECT_SCOPED_TABLES = [
  "Credential",
  "Provider",
  "ModelDeployment",
  "Budget",
  "ApiKey",
  "SpendLog",
  "ErrorLog",
  "DailySpend",
  "AuditLog",
] as const;

/**
 * One-time migration: assign gateway rows with an empty/NULL projectId
 * (created before project scoping existed) to the oldest project so they
 * become visible again under project-isolated queries. Idempotent — once a
 * row has a real projectId it is never touched again.
 *
 * Must run after `ensureBootstrap()` so at least one project exists.
 */
export async function migrateOrphanedGatewayData(): Promise<void> {
  const db = getDb();

  const oldest = await prisma
    .select({ id: projects.id })
    .from(projects)
    .orderBy(asc(projects.createdAt))
    .limit(1);
  const projectId = oldest[0]?.id;
  if (!projectId) {
    // No projects yet (fresh install) — nothing to assign to.
    return;
  }

  let total = 0;
  for (const table of GATEWAY_PROJECT_SCOPED_TABLES) {
    const result = db.run(
      sql`UPDATE ${sql.raw(table)} SET projectId = ${projectId} WHERE projectId IS NULL OR projectId = ''`,
    );
    total += result.changes;
  }

  if (total > 0) {
    logger.info(`[gateway-init] Migrated ${total} orphaned gateway row(s) to project ${projectId}`);
  }
}
