/**
 * Stub: Redis is not available in lite mode.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Redis = any;

export function getRedis(): any {
  return null;
}

export const redis: any = null;

export async function safeMultiDel(_redis: any, _keys: string[]): Promise<void> {}

export async function scanKeys(_redis: any, _pattern: string): Promise<string[]> {
  return [];
}
