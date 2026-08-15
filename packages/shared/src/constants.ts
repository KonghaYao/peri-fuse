// disable lint as this is exported and used in packages

/**
 * Declared API compatibility surface version (semver).
 * Served by GET /api/public/health so that langfuse-cli (`--api-version auto`)
 * can match its built-in version against the server's API surface.
 */
export const API_COMPAT_VERSION = "4.10.0";

export enum ModelUsageUnit {
  Characters = "CHARACTERS",
  Tokens = "TOKENS",
  Seconds = "SECONDS",
  Milliseconds = "MILLISECONDS",
  Images = "IMAGES",
  Requests = "REQUESTS",
}
