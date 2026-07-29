/** Stub: Webhook IP blocking not available in lite mode. */
export function isIpBlocked(_ip: string): boolean {
  return false;
}
export function isIPBlocked(
  _ip: string,
  _allowedIps?: string[],
  _allowedRanges?: string[],
): boolean {
  return false;
}
export function isHostnameBlocked(_hostname: string): boolean {
  return false;
}
export function isIPAddress(_value: string): boolean {
  return false;
}
export async function checkIpBlocklist(_ip: string): Promise<boolean> {
  return false;
}
