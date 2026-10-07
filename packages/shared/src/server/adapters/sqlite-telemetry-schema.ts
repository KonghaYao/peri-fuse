import { join } from "node:path";
import { findLocalPackageRoot, type LocalExecutor, readLocalMigrations } from "../../db/local";

export function readTelemetryMigrations() {
  return readLocalMigrations(join(findLocalPackageRoot(__dirname), "telemetry-drizzle"));
}

export async function initializeTelemetrySchema(db: LocalExecutor): Promise<void> {
  for (const migration of readTelemetryMigrations()) {
    for (const statement of migration.sql.split("--> statement-breakpoint")) {
      const idempotent = statement
        .replace(/CREATE TABLE /g, "CREATE TABLE IF NOT EXISTS ")
        .replace(/CREATE UNIQUE INDEX /g, "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replace(/CREATE INDEX /g, "CREATE INDEX IF NOT EXISTS ");
      if (idempotent.trim()) await db.exec(idempotent);
    }
  }
}
