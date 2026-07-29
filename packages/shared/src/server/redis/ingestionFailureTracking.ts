/** Stub: Ingestion failure tracking not available in lite mode. */
export async function trackIngestionFailure(_projectId: string, _error: unknown): Promise<void> {}
export async function getIngestionFailureCount(_projectId: string): Promise<number> {
  return 0;
}
export async function markProjectIngestFailure(_projectId: string, _opts?: any): Promise<void> {}
