/**
 * In-memory cache adapter using LRU eviction.
 * Replaces Redis for caching in lite mode.
 */

import { LRUCache } from "lru-cache";
import type { CacheAdapter } from "./types";

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class InMemoryCacheAdapter implements CacheAdapter {
  private cache: LRUCache<string, string>;

  constructor(opts?: { max?: number; ttlMs?: number }) {
    this.cache = new LRUCache<string, string>({
      max: opts?.max ?? DEFAULT_MAX_ENTRIES,
      ttl: opts?.ttlMs ?? DEFAULT_TTL_MS,
    });
  }

  async get<T = string>(key: string): Promise<T | null> {
    const value = this.cache.get(key);
    if (value === undefined) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.cache.set(key, value, ttlSeconds ? { ttl: ttlSeconds * 1000 } : undefined);
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.cache.get(key) ?? null);
  }

  async mset(entries: Array<{ key: string; value: string; ttlSeconds?: number }>): Promise<void> {
    for (const entry of entries) {
      this.cache.set(
        entry.key,
        entry.value,
        entry.ttlSeconds ? { ttl: entry.ttlSeconds * 1000 } : undefined,
      );
    }
  }

  async incr(key: string): Promise<number> {
    const current = this.cache.get(key);
    const next = (current ? parseInt(current, 10) : 0) + 1;
    this.cache.set(key, String(next));
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Re-set with new TTL
      this.cache.set(key, value, { ttl: ttlSeconds * 1000 });
    }
  }

  async close(): Promise<void> {
    this.cache.clear();
  }
}
