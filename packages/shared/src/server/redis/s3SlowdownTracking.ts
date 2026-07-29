/** Stub: S3 slowdown tracking not available in lite mode. */
export async function trackS3Slowdown(_projectId: string): Promise<void> {}
export async function isS3SlowedDown(_projectId: string): Promise<boolean> {
  return false;
}
export function isS3SlowDownError(_error: unknown): boolean {
  return false;
}
export async function markProjectS3Slowdown(_projectId: string): Promise<void> {}
