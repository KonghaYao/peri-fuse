/**
 * Bounded TTL response cache for read-only public API endpoints.
 *
 * The telemetry store is a single synchronous better-sqlite3 handle, so every
 * uncached aggregate query blocks the whole event loop. Read endpoints are
 * dominated by repeat traffic (UI polling, refresh, multiple viewers of the
 * same dashboard), which makes a few seconds of reuse extremely effective.
 *
 * Design constraints honored here:
 *  - Project isolation: the cache key always includes the authenticated
 *    projectId; different API keys never share entries.
 *  - Bounded memory: both entry count and total body bytes are capped;
 *    insertion-ordered eviction keeps RSS predictable ("low memory" by design).
 *  - Singleflight: when an entry expires under concurrency, only ONE request
 *    recomputes; all others await the same promise instead of stampeding the
 *    database (thundering-herd protection).
 *  - Correctness: only 200 responses are cached; TTLs are deliberately short
 *    (seconds) so numbers never feel stale.
 *
 * Mount AFTER authMiddleware so the verified scope is available:
 *   app.get("/api/public/x", authMiddleware, responseCache(2_000), handler);
 */

import type { MiddlewareHandler } from "hono";
import type { LiteServerEnv } from "./auth";

const MAX_ENTRIES = 1024;
const MAX_BYTES = 32 * 1024 * 1024; // 32 MiB total body cap

type CacheEntry = {
  expiresAt: number;
  body: string;
  contentType: string;
};

// Insertion-ordered map doubles as a coarse LRU: hits are re-inserted at the
// tail, eviction always takes from the head.
const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

// In-flight recomputations keyed like cache entries (singleflight).
const inflight = new Map<string, Promise<Response | null>>();

function dropEntry(key: string): void {
  const entry = cache.get(key);
  if (entry) {
    totalBytes -= entry.body.length;
    cache.delete(key);
  }
}

/** Evict oldest entries until a new body of `bytes` fits both caps. */
function makeRoom(bytes: number): void {
  while (cache.size > 0 && (cache.size >= MAX_ENTRIES || totalBytes + bytes > MAX_BYTES)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    dropEntry(oldest);
  }
}

function cacheKey(projectId: string, reqUrl: string): string {
  const url = new URL(reqUrl);
  return `${projectId}|${url.pathname}|${url.search}`;
}

/**
 * Response-caching middleware. `ttlMs` is the lifetime of a cached response;
 * pass a function of the request context to vary it (e.g. longer TTLs for
 * historical windows whose data barely changes). Must run after
 * authMiddleware (needs `auth.scope.projectId`).
 */
export function responseCache(
  ttlMs: number | ((c: Parameters<MiddlewareHandler<LiteServerEnv>>[0]) => number),
): MiddlewareHandler<LiteServerEnv> {
  return async (c, next) => {
    if (c.req.method !== "GET") return next();
    const projectId = c.get("auth")?.scope?.projectId;
    if (!projectId) return next();

    const key = cacheKey(projectId, c.req.url);
    const now = Date.now();

    const hit = cache.get(key);
    if (hit) {
      if (now < hit.expiresAt) {
        // Refresh LRU position.
        cache.delete(key);
        cache.set(key, hit);
        c.header("X-Cache", "HIT");
        return c.body(hit.body, 200, { "Content-Type": hit.contentType });
      }
      dropEntry(key);
    }

    // Singleflight: join an ongoing recompute instead of starting another.
    let pending = inflight.get(key);
    let owner = false;
    if (!pending) {
      owner = true;
      let finish: (v: Response | null) => void = () => {};
      pending = new Promise<Response | null>((resolve) => {
        finish = resolve;
      });
      (pending as Promise<Response | null> & { finish?: typeof finish }).finish = finish;
      inflight.set(key, pending);
    }

    if (!owner) {
      const shared = await pending;
      if (shared) {
        c.header("X-Cache", "HIT");
        // Clone so each waiter gets an unconsumed body. arrayBuffer (not text)
        // so oversized bodies don't hit the V8 string cap.
        const buf = await shared.clone().arrayBuffer();
        return c.body(buf, 200, {
          "Content-Type": shared.headers.get("content-type") ?? "application/json",
        });
      }
      // The owner failed; fall through and compute this request normally.
      return next();
    }

    try {
      await next();
      const res = c.res;
      if (res.status !== 200) return;

      // Oversized bodies are served straight through: decoding them into a
      // string hits the V8 string cap (text() throws past ~512 MiB), and a
      // body beyond MAX_BYTES would only evict the whole cache anyway.
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) {
        c.header("X-Cache", "SKIP");
        const finish = (
          pending as Promise<Response | null> & {
            finish?: (v: Response | null) => void;
          }
        ).finish;
        finish?.(res.clone());
        return;
      }

      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "application/json";
      if (buf.byteLength > MAX_BYTES) {
        c.res = new Response(buf, { status: 200, headers: res.headers });
        c.header("X-Cache", "SKIP");
        const finish = (
          pending as Promise<Response | null> & {
            finish?: (v: Response | null) => void;
          }
        ).finish;
        finish?.(new Response(buf, { status: 200, headers: { "Content-Type": contentType } }));
        return;
      }

      const body = new TextDecoder().decode(buf);
      // The body stream was consumed above — hand the client an equivalent one.
      c.res = new Response(body, { status: 200, headers: res.headers });
      c.header("X-Cache", "MISS");

      makeRoom(body.length);
      const ttl = typeof ttlMs === "function" ? ttlMs(c) : ttlMs;
      cache.set(key, { expiresAt: Date.now() + ttl, body, contentType });
      totalBytes += body.length;

      const finish = (
        pending as Promise<Response | null> & {
          finish?: (v: Response | null) => void;
        }
      ).finish;
      finish?.(new Response(body, { status: 200, headers: { "Content-Type": contentType } }));
    } catch (error) {
      const finish = (
        pending as Promise<Response | null> & {
          finish?: (v: Response | null) => void;
        }
      ).finish;
      finish?.(null);
      throw error;
    } finally {
      inflight.delete(key);
    }
  };
}

/** Test/ops hook: current cache footprint. */
export function responseCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: totalBytes };
}

/** Test/ops hook: clear all cached responses. */
export function clearResponseCache(): void {
  cache.clear();
  totalBytes = 0;
}
