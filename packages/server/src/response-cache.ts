/** Project-scoped response cache with bounded bodies and cancellable singleflight. */
import { throwIfTelemetryQueryFailed } from "@peri-fuse/shared/src/server/adapters";
import type { MiddlewareHandler } from "hono";
import type { LiteServerEnv } from "./auth";
import { bufferSmallResponse } from "./bounded-response";

const MAX_ENTRIES = 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_INFLIGHT = 128;
const MAX_WAITERS = 64;
type SharedResponse = { body: Uint8Array<ArrayBuffer>; status: number; headers: Headers };
type CacheEntry = SharedResponse & { expiresAt: number };
type Pending = {
  finish: (value: SharedResponse | null) => void;
  subscribers: Set<(value: SharedResponse | null) => void>;
};
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Pending>();
let totalBytes = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function dropEntry(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.body.byteLength;
  cache.delete(key);
}
function scheduleExpiry(): void {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (cache.size === 0) return;
  let earliest = Infinity;
  for (const entry of cache.values()) earliest = Math.min(earliest, entry.expiresAt);
  expiryTimer = setTimeout(
    () => {
      for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) dropEntry(key);
      scheduleExpiry();
    },
    Math.max(1, earliest - Date.now()),
  );
  expiryTimer.unref();
}
function makeRoom(bytes: number): void {
  while (cache.size > 0 && (cache.size >= MAX_ENTRIES || totalBytes + bytes > MAX_BYTES)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) dropEntry(oldest);
  }
}
function join(pending: Pending, signal: AbortSignal, timeoutMs: number) {
  return new Promise<SharedResponse | null>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      pending.subscribers.delete(deliver);
    };
    const deliver = (value: SharedResponse | null) => {
      cleanup();
      resolve(value);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Request cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Response wait timed out"));
    }, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    pending.subscribers.add(deliver);
    if (signal.aborted) abort();
  });
}
/** Cache only small successful GETs; every owner outcome settles its waiters. */
export function responseCache(
  ttlMs: number | ((c: Parameters<MiddlewareHandler<LiteServerEnv>>[0]) => number),
  options: { waitTimeoutMs?: number } = {},
): MiddlewareHandler<LiteServerEnv> {
  return async (c, next) => {
    const projectId = c.get("auth")?.scope?.projectId;
    if (c.req.method !== "GET" || !projectId) return next();
    const url = new URL(c.req.url);
    const key = `${projectId}|${url.pathname}|${url.search}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, hit);
      const headers = new Headers(hit.headers);
      headers.set("X-Cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers });
    }
    if (hit) dropEntry(key);
    const existing = inflight.get(key);
    if (existing) {
      if (existing.subscribers.size >= MAX_WAITERS)
        return c.json({ message: "Too many waiting requests" }, 503);
      try {
        const shared = await join(existing, c.req.raw.signal, options.waitTimeoutMs ?? 30_000);
        if (shared) {
          const headers = new Headers(shared.headers);
          headers.set("X-Cache", "HIT");
          return new Response(shared.body, { status: shared.status, headers });
        }
      } catch {
        return c.json({ message: "Response wait cancelled or timed out" }, 408);
      }
      return next();
    }
    if (inflight.size >= MAX_INFLIGHT) return c.json({ message: "Too many active requests" }, 503);
    const pending: Pending = {
      subscribers: new Set(),
      finish(value) {
        for (const deliver of this.subscribers) deliver(value);
        this.subscribers.clear();
      },
    };
    inflight.set(key, pending);
    try {
      await next();
      // Legacy repositories may return [] after catching an adapter limit error.
      // Reject before sharing or caching that fallback as a successful response.
      throwIfTelemetryQueryFailed();
      const response = c.res;
      if (!response.body) return;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        c.header("X-Cache", "SKIP");
        return;
      }
      const result = await bufferSmallResponse(response, MAX_ENTRY_BYTES, c.req.raw.signal);
      c.res = result.response;
      if (!result.body) {
        c.header("X-Cache", "SKIP");
        return;
      }
      const shared: SharedResponse = {
        body: result.body,
        status: response.status,
        headers: new Headers(response.headers),
      };
      if (response.status === 200) {
        makeRoom(shared.body.byteLength);
        const ttl = typeof ttlMs === "function" ? ttlMs(c) : ttlMs;
        cache.set(key, { ...shared, expiresAt: Date.now() + ttl });
        totalBytes += shared.body.byteLength;
        scheduleExpiry();
        c.header("X-Cache", "MISS");
      }
      pending.finish(shared);
    } finally {
      pending.finish(null);
      inflight.delete(key);
    }
  };
}
/** Actual retained payload bytes; headers/key overhead is bounded by entry count. */
export function responseCacheStats() {
  return { entries: cache.size, bytes: totalBytes, inflight: inflight.size };
}
export function clearResponseCache(): void {
  cache.clear();
  totalBytes = 0;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
}
