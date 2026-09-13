import { describe, expect, it, vi } from "vitest";
import { bufferSmallResponse } from "../bounded-response";

const signal = () => new AbortController().signal;

describe("bounded response buffering", () => {
  it("coalesces tiny and empty chunks into a bounded prefix and preserves every byte", async () => {
    let index = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (index === 512) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array());
          controller.enqueue(Uint8Array.of(index++ % 256));
        },
      },
      { highWaterMark: 0 },
    );
    const result = await bufferSmallResponse(new Response(source), 128, signal());
    expect(result.body).toBeUndefined();
    const reader = result.response.body!.getReader();
    const prefix = (await reader.read()).value!;
    expect(prefix.byteLength).toBe(128);
    const bytes = [...prefix];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes.push(...next.value);
    }
    expect(bytes).toEqual(Array.from({ length: 512 }, (_, i) => i % 256));
    expect(source.locked).toBe(false);
  });

  it("caches a small response and preserves its status and headers", async () => {
    const response = new Response("中文", { status: 201, headers: { "x-result": "ok" } });
    const result = await bufferSmallResponse(response, 100, signal());
    expect(result.body).toEqual(new TextEncoder().encode("中文"));
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("x-result")).toBe("ok");
    expect(await result.response.text()).toBe("中文");
    expect(response.body!.locked).toBe(false);
  });

  it("skips a declared oversized body without reading its stream", async () => {
    const pull = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = new Response(source, { headers: { "content-length": "1000" } });
    const result = await bufferSmallResponse(response, 10, signal());
    expect(result.response).toBe(response);
    expect(pull).not.toHaveBeenCalled();
    await source.cancel();
  });

  it("cancels a stalled buffering read when the request aborts", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const result = bufferSmallResponse(response, 100, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it("cancels pass-through bodies and errors a read interrupted by abort", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3, 4));
      },
      cancel,
    });
    const controller = new AbortController();
    const result = await bufferSmallResponse(new Response(source), 2, controller.signal);
    const reader = result.response.body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1, 2, 3, 4));
    const pending = reader.read();
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("downstream cancel releases the original source lock", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
      },
      cancel,
    });
    const result = await bufferSmallResponse(new Response(source), 10, signal());
    await result.response.body!.cancel("no longer needed");
    expect(cancel).toHaveBeenCalledWith("no longer needed");
    expect(source.locked).toBe(false);
  });
});
