/**
 * responseCache middleware unit tests — oversized bodies are served straight
 * through instead of hitting the V8 string cap while decoding (text() on a
 * body past ~512 MiB throws RangeError).
 */

import type {
  AuthHeaderValidVerificationResultIngestion,
  AuthScope,
} from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { LiteServerEnv } from "../auth.js";
import { clearResponseCache, responseCache } from "../response-cache.js";

const MAX_BYTES = 32 * 1024 * 1024;

function makeApp(): Hono<LiteServerEnv> {
  const app = new Hono<LiteServerEnv>();
  app.use("*", async (c, next) => {
    // Test-only mock: metadata fields are irrelevant for the cache middleware.
    c.set("auth", {
      validKey: true,
      scope: { projectId: "p1", accessLevel: "project" },
    } as AuthHeaderValidVerificationResultIngestion & { scope: AuthScope });
    await next();
  });
  return app;
}

describe("responseCache", () => {
  it("caches small responses and serves HIT on repeat", async () => {
    clearResponseCache();
    const app = makeApp();
    app.get("/small", responseCache(60_000), (c) => c.json({ ok: true }));

    const first = await app.request("/small");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");

    const second = await app.request("/small");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.json()).toEqual({ ok: true });
  });

  it("serves oversized bodies straight through instead of crashing", async () => {
    clearResponseCache();
    const app = makeApp();
    const big = "x".repeat(MAX_BYTES + 1024);
    app.get("/big", responseCache(60_000), (c) => c.body(big));

    const res = await app.request("/big");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("SKIP");
    expect((await res.arrayBuffer()).byteLength).toBe(MAX_BYTES + 1024);

    // Not cached — a repeat is SKIP again, never a stale HIT.
    const again = await app.request("/big");
    expect(again.headers.get("x-cache")).toBe("SKIP");
  });

  it("skips before reading the body when content-length is already known to be huge", async () => {
    clearResponseCache();
    const app = makeApp();
    app.get(
      "/declared",
      responseCache(60_000),
      () => new Response("ignored-body", { headers: { "content-length": String(MAX_BYTES + 1) } }),
    );

    const res = await app.request("/declared");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("SKIP");
  });
});
