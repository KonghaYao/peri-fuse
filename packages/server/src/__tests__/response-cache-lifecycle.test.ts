import {
  getTelemetryDB,
  TelemetryQueryError,
  withTelemetryQuerySignal,
} from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { LiteServerEnv } from "../auth";
import { clearResponseCache, responseCache, responseCacheStats } from "../response-cache";

function makeApp() {
  const app = new Hono<LiteServerEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", { validKey: true, scope: { projectId: "cache-project" } } as NonNullable<
      ReturnType<typeof c.get<"auth">>
    >);
    await next();
  });
  return app;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function within<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Request remained pending")), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(clearResponseCache);

describe("response cache lifecycle", () => {
  it.each([400, 404, 500] as const)("settles all waiters on status %i", async (status) => {
    const app = makeApp();
    app.get("/error", responseCache(1_000), async (c) => {
      await pause(10);
      return c.json({ message: "expected error" }, status);
    });
    const responses = await within(
      Promise.all(Array.from({ length: 20 }, () => app.request("/error"))),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(status));
    expect(responseCacheStats().entries).toBe(0);
  });

  it("settles waiters when the handler throws", async () => {
    const app = makeApp();
    app.onError((_, c) => c.json({ message: "expected error" }, 500));
    app.get("/throw", responseCache(1_000), async () => {
      await pause(10);
      throw new Error("expected");
    });
    const responses = await within(Promise.all([app.request("/throw"), app.request("/throw")]));
    expect(responses.map((response) => response.status)).toEqual([500, 500]);
  });

  it("aborts a waiter without cancelling the owner's computation", async () => {
    const app = makeApp();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get("/cancel", responseCache(1_000), async (c) => {
      await gate;
      return c.json({ ok: true });
    });
    const owner = app.request("/cancel");
    await pause(5);
    const controller = new AbortController();
    const waiter = app.request("/cancel", { signal: controller.signal });
    controller.abort();
    expect((await within(waiter)).status).toBe(408);
    release();
    expect((await within(owner)).status).toBe(200);
  });

  it("counts actual UTF-8 payload bytes", async () => {
    const app = makeApp();
    const body = "内存测试";
    app.get("/bytes", responseCache(1_000), (c) => c.text(body));
    expect(await (await app.request("/bytes")).text()).toBe(body);
    expect(responseCacheStats().bytes).toBe(Buffer.byteLength(body));
  });

  it("streams an unknown-length large response without reading it all for the cache", async () => {
    const app = makeApp();
    let reads = 0;
    let cancelled = false;
    app.get(
      "/large",
      responseCache(1_000),
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array(256 * 1024));
              if (reads === 100) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const response = await within(app.request("/large"));
    expect(response.headers.get("x-cache")).toBe("SKIP");
    expect(reads).toBeLessThan(10);
    await response.body?.cancel();
    expect(cancelled).toBe(true);
    expect(responseCacheStats().entries).toBe(0);
  });

  it("never shares or caches successful fallback data after a swallowed resource error", async () => {
    const app = makeApp();
    app.onError((error, c) =>
      c.json({ message: error.message }, error instanceof TelemetryQueryError ? 413 : 500),
    );
    app.use("/resource", async (c, next) => withTelemetryQuerySignal(c.req.raw.signal, next));
    let fail = true;
    let calls = 0;
    app.get("/resource", responseCache(10_000), async (c) => {
      calls++;
      await pause(10);
      const rows = fail
        ? await getTelemetryDB()
            .query({ query: "SELECT 1 UNION ALL SELECT 2", maxResultRows: 1 })
            .catch(() => [])
        : [{ n: 1 }];
      return c.json(rows);
    });
    const responses = await within(
      Promise.all([app.request("/resource"), app.request("/resource")]),
    );
    expect(responses.map((response) => response.status)).toEqual([413, 413]);
    for (const response of responses) {
      expect(response.headers.get("X-Cache")).not.toBe("HIT");
      await response.text();
    }
    expect(responseCacheStats()).toMatchObject({ entries: 0, inflight: 0 });
    fail = false;
    const recovered = await app.request("/resource");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual([{ n: 1 }]);
    expect(recovered.headers.get("X-Cache")).toBe("MISS");
    expect(calls).toBe(3);
  });
});
