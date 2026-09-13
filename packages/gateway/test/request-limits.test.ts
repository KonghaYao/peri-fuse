import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { GatewayEnv } from "../src/app.js";
import { gatewayRequestLimits } from "../src/middleware/request-limits.js";

function app(options: { maxActive?: number; maxBodyBytes?: number }) {
  const app = new Hono<GatewayEnv>();
  app.use("*", gatewayRequestLimits(options));
  app.onError((_error, c) => c.json({ error: "handler rejected" }, 500));
  app.post("/input", async (c) => c.json({ input: await c.req.text() }));
  return app;
}

describe("Gateway request admission", () => {
  it.each([undefined, "1"])(
    "rejects streaming overflow with Content-Length %s",
    async (contentLength) => {
      const cancel = vi.fn();
      let count = 0;
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("12345678"));
          if (++count > 8) controller.close();
        },
        cancel,
      });
      const init = {
        method: "POST",
        body,
        duplex: "half",
        headers: contentLength ? { "Content-Length": contentLength } : undefined,
      };
      const response = await app({ maxBodyBytes: 10 }).request(
        new Request("http://test/input", init),
      );
      expect(response.status).toBe(413);
      await response.text();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    },
  );

  it("keeps a slot until an SSE response is cancelled, then admits another request", async () => {
    const server = app({ maxActive: 1 });
    const cancel = vi.fn();
    server.get(
      "/stream",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
            },
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const first = await server.request("/stream");
    const rejected = await server.request("/input", { method: "POST", body: "test" });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("Retry-After")).toBe("1");
    await first.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    const next = await server.request("/input", { method: "POST", body: "test" });
    expect(next.status).toBe(200);
    await next.text();
  });

  it("releases admission on raw request abort while streaming", async () => {
    const server = app({ maxActive: 1 });
    const cancel = vi.fn();
    server.get("/stream", () => new Response(new ReadableStream({ cancel })));
    const client = new AbortController();
    const first = await server.request("/stream", { signal: client.signal });
    client.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      const next = await server.request("/input", { method: "POST", body: "test" });
      expect(next.status).toBe(200);
      await next.text();
    });
    await first.body!.cancel().catch(() => {});
  });

  it("releases admission after responses finish and handler errors", async () => {
    const server = app({ maxActive: 1 });
    server.get("/error", () => {
      throw new Error("failed");
    });
    await (await server.request("/error")).text();
    for (let i = 0; i < 3; i++) {
      const response = await server.request("/input", { method: "POST", body: "test" });
      expect(response.status).toBe(200);
      await response.text();
    }
  });

  it("aborts a stalled upload parser and then recovers admission", async () => {
    const server = app({ maxActive: 1 });
    const client = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const init = { method: "POST", signal: client.signal, body: source, duplex: "half" };
    const pending = server.request(new Request("http://test/input", init));
    client.abort();
    const response = await pending;
    await response.text().catch(() => {});
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    const next = await server.request("/input", { method: "POST", body: "test" });
    expect(next.status).toBe(200);
    await next.text();
  });

  it("cancels unconsumed uploads when a handler ignores the body", async () => {
    const server = app({ maxActive: 1 });
    server.post("/ignore", (c) => c.json({ ok: true }));
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const init = { method: "POST", body: source, duplex: "half" };
    const response = await server.request(new Request("http://test/ignore", init));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("holds admission until delayed producer cancellation completes", async () => {
    const server = app({ maxActive: 1 });
    let finishCancel: () => void = () => {};
    const cancellation = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    server.get("/slow-cancel", () => new Response(new ReadableStream({ cancel })));
    const response = await server.request("/slow-cancel");
    const closing = response.body!.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect((await server.request("/input", { method: "POST", body: "test" })).status).toBe(503);
    finishCancel();
    await closing;
    const recovered = await server.request("/input", { method: "POST", body: "test" });
    expect(recovered.status).toBe(200);
    await recovered.text();
  });
});
