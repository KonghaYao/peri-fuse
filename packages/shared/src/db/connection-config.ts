import { createDatabaseError } from "./errors";

export type DatabaseRole = "metadata" | "telemetry" | "gateway";
export type DatabaseConnectionConfig = { url: string; authToken?: string };
export type LocalDatabaseEngine = "turso" | "sqlite";

/**
 * Selects the local execution engine. Only `PERIFUSE_ENGINE` is read; a generic
 * `ENGINE` variable belongs to the host application and is ignored on purpose.
 * Invalid values fail here so a typo can never silently downgrade the engine,
 * and the raw input is never echoed back.
 */
export function resolveLocalEngine(
  environment: NodeJS.ProcessEnv = process.env,
): LocalDatabaseEngine {
  const value = environment.PERIFUSE_ENGINE?.trim();
  if (!value) return "turso";
  if (value === "turso" || value === "sqlite") return value;
  throw createDatabaseError("PERIFUSE_INVALID_ENGINE", "PERIFUSE_ENGINE must be turso or sqlite");
}

export function isRemoteDatabaseUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^file:/i.test(url);
}

export function validateDatabaseConfig(config: DatabaseConnectionConfig): DatabaseConnectionConfig {
  const url = config.url.trim();
  if (!isRemoteDatabaseUrl(url)) return { url };
  const authToken = config.authToken?.trim();
  return authToken ? { url, authToken } : { url };
}

export function resolveDatabaseConfig(
  role: DatabaseRole,
  fallbackUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionConfig {
  const configured = (value: string | undefined) => value?.trim() || undefined;
  const prefix = `TURSO_${role.toUpperCase()}`;
  const legacy =
    role === "metadata"
      ? environment.DATABASE_URL
      : role === "telemetry"
        ? environment.LANGFUSE_SQLITE_DB_PATH
        : environment.GATEWAY_DB_URL;
  return validateDatabaseConfig({
    url:
      configured(environment[`${prefix}_DATABASE_URL`]) ??
      configured(environment.TURSO_DATABASE_URL) ??
      configured(legacy) ??
      fallbackUrl,
    authToken:
      configured(environment[`${prefix}_AUTH_TOKEN`]) ?? configured(environment.TURSO_AUTH_TOKEN),
  });
}
