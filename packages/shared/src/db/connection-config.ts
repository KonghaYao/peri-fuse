export type DatabaseRole = "metadata" | "telemetry" | "gateway";
export type DatabaseConnectionConfig = { url: string; authToken?: string };

export function isRemoteDatabaseUrl(url: string): boolean {
  return /^(libsql|https?|wss?):\/\//i.test(url);
}

export function validateDatabaseConfig(config: DatabaseConnectionConfig): DatabaseConnectionConfig {
  const url = config.url.trim();
  if (!url) throw new Error("Database URL must not be empty");
  if (!isRemoteDatabaseUrl(url)) return { url };
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Database URL must not contain credentials, query parameters or fragments");
  if (!parsed.hostname || (parsed.pathname !== "" && parsed.pathname !== "/"))
    throw new Error("Remote database URL must specify a database host without a path");
  if (["ws:", "wss:"].includes(parsed.protocol))
    throw new Error("Use a libsql:// or HTTPS Turso URL for the HTTP database client");
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new Error(
      "Remote database connections require TLS; HTTP is only allowed for loopback development",
    );
  const authToken = config.authToken?.trim();
  if (!authToken) throw new Error("Turso auth token is required for a remote database");
  return { url, authToken };
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
