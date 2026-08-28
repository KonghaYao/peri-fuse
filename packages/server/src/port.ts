export const DEFAULT_LITE_SERVER_PORT = 23332;

/** Resolve the configured HTTP port without importing environment bootstrap side effects. */
export function resolveLiteServerPort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort === "") return DEFAULT_LITE_SERVER_PORT;
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) {
    throw new Error("LITE_SERVER_PORT must be a decimal integer between 1 and 65535");
  }

  const port = Number(rawPort);
  if (port > 65535) {
    throw new Error("LITE_SERVER_PORT must be a decimal integer between 1 and 65535");
  }
  return port;
}
