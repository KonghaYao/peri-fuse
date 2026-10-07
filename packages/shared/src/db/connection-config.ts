export type DatabaseRole = "metadata" | "telemetry" | "gateway";
export type DatabaseConnectionConfig = { url: string; authToken?: string };

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
