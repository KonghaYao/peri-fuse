import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { LiteServerEnv } from "../auth";

vi.mock("@peri-fuse/shared/src/server/adapters", () => ({
  withTelemetryQuerySignal: (_signal: AbortSignal, callback: () => unknown) => callback(),
}));

import { requestLimits } from "../request-limits";

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
function appWithLimits(options: Parameters<typeof requestLimits>[0] = {}) {
  const app = new Hono<LiteServerEnv>();
  app.use("*", requestLimits(options));
  app.onError((error, c) =>
    c.json({ message: error.message }, c.req.raw.signal.aborted ? 408 : 500),
  );
  return app;
}
function upload(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; length?: string } = {},
) {
  return new Request("http://localhost/", {
    method: "POST",
    body,
    duplex: "half",
    signal: options.signal,
    headers: options.length ? { "content-length": options.length } : undefined,
  } as RequestInit);
}

describe("request lifecycle admission", () => {
  it("holds capacity until a response body is consumed or cancelled", async () => {
    const app = appWithLimits({ maxActive: 1 });
    const cancel = vi.fn();
    app.get("/", () => new Response(new ReadableStream({ cancel })));
    const first = await app.request("/");
    expect((await app.request("/")).status).toBe(503);
    await first.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    const next = await app.request("/");
    expect(next.status).toBe(200);
    await next.body!.cancel();
  });

  it("keeps response capacity while producer cancellation is still running", async () => {
    const app = appWithLimits({ maxActive: 1 });
    let finishCancellation!: () => void;
    app.get(
      "/slow",
      () =>
        new Response(
          new ReadableStream({
            cancel: () =>
              new Promise<void>((resolve) => {
                finishCancellation = resolve;
              }),
          }),
        ),
    );
    app.get("/", (c) => c.text("ready"));
    const controller = new AbortController();
    const response = await app.request("/slow", { signal: controller.signal });
    const pending = response.body!.getReader().read();
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect((await app.request("/")).status).toBe(503);
    finishCancellation();
    await pause();
    const next = await app.request("/");
    expect(next.status).toBe(200);
    await next.text();
  });

  it("does not release an aborted handler's slot before the handler finishes", async () => {
    const app = appWithLimits({ maxActive: 1 });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app.get("/", async (c) => {
      await gate;
      return c.text("done");
    });
    const controller = new AbortController();
    const first = app.request("/", { signal: controller.signal });
    await pause();
    controller.abort();
    expect((await app.request("/")).status).toBe(503);
    finish();
    await first;
    await pause();
    expect((await app.request("/")).status).toBe(200);
  });

  it("cancels request uploads rejected by declared size or admission", async () => {
    const app = appWithLimits({ maxActive: 1, maxBodyBytes: 10 });
    app.post("/", () => new Response(new ReadableStream()));
    const oversizedCancel = vi.fn();
    expect(
      (await app.request(upload(new ReadableStream({ cancel: oversizedCancel }), { length: "11" })))
        .status,
    ).toBe(413);
    expect(oversizedCancel).toHaveBeenCalledOnce();
    const first = await app.request(upload(new ReadableStream()));
    const overloadedCancel = vi.fn();
    expect(
      (await app.request(upload(new ReadableStream({ cancel: overloadedCancel })))).status,
    ).toBe(503);
    expect(overloadedCancel).toHaveBeenCalledOnce();
    await first.body!.cancel();
  });

  it.each([undefined, "1"])("enforces streamed bytes when Content-Length is %s", async (length) => {
    const app = appWithLimits({ maxBodyBytes: 10 });
    app.post("/", async (c) => c.text(await c.req.text()));
    const cancel = vi.fn();
    const response = await app.request(
      upload(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(11));
          },
          cancel,
        }),
        { length },
      ),
    );
    expect(response.status).toBe(413);
    await response.text();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels uploads ignored by handlers, including failed authentication", async () => {
    const app = appWithLimits();
    app.post("/", (c) => c.json({ message: "unauthorized" }, 401));
    const cancel = vi.fn();
    const response = await app.request(upload(new ReadableStream({ cancel })));
    expect(response.status).toBe(401);
    await response.text();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborting a stalled upload interrupts body parsing and frees admission", async () => {
    const app = appWithLimits({ maxActive: 1 });
    app.post("/", async (c) => c.json(await c.req.json()));
    app.get("/", (c) => c.text("ready"));
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = app.request(
      upload(new ReadableStream({ cancel }), { signal: controller.signal }),
    );
    await pause();
    controller.abort();
    expect((await pending).status).toBe(408);
    await pause();
    expect(cancel).toHaveBeenCalledOnce();
    const next = await app.request("/");
    expect(next.status).toBe(200);
    await next.text();
  });
});
