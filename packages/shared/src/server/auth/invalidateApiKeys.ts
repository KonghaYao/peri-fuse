/** Stub: API key invalidation via Redis not available in lite mode. */
export async function invalidateApiKeysCache(_orgId: string): Promise<void> {}
export async function invalidateCachedApiKeys(
  _keys: any,
  _label?: any,
  _redis?: any,
): Promise<void> {}
