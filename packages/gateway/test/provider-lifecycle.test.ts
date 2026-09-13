import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeriRequest } from "../src/protocol/types.js";
import { readBoundedText } from "../src/provider/lifecycle.js";
import { OpenAIAdapter } from "../src/provider/openai.js";

const request: PeriRequest = { model: "test", messages: [], stream: true };
const event = 'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n';
const encoder = new TextEncoder();

function adapter(signal?: AbortSignal) {
  return new OpenAIAdapter({ baseUrl: "https://provider.invalid", apiKey: "test", signal });
}
function mockBody(text: string) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  return { body, cancel };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Provider lifetime", () => {
  it("aborts fetch before headers arrive", async () => {
    const client = new AbortController();
    const fetchMock = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = adapter(client.signal).call(request, "test");
    client.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it("cancels and unlocks unread data after DONE", async () => {
    const { body, cancel } = mockBody(`${event}data: [DONE]\n\n`);
    const result = await adapter().callStream(request, "test");
    const chunks = [];
    for await (const chunk of result.stream!) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("cancels when the consumer breaks or never starts the iterable", async () => {
    const first = mockBody(event);
    const result = await adapter().callStream(request, "test");
    for await (const _chunk of result.stream!) break;
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.body.locked).toBe(false);
    const second = mockBody(event);
    const unused = await adapter().callStream(request, "test");
    unused.cancel?.();
    await vi.waitFor(() => expect(second.body.locked).toBe(false));
    expect(second.cancel).toHaveBeenCalledOnce();
  });

  it("interrupts a pending read on downstream abort", async () => {
    const client = new AbortController();
    const { cancel, body } = mockBody(event);
    const result = await adapter(client.signal).callStream(request, "test");
    const iterator = result.stream![Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    client.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("clears completed request timers", async () => {
    vi.useFakeTimers();
    mockBody("data: [DONE]\n\n");
    const result = await adapter().callStream(request, "test");
    for await (const _chunk of result.stream!) {
      /* consume */
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits SSE lines and cancels oversized JSON and error bodies", async () => {
    let source = mockBody(`data: ${"x".repeat(1024 * 1024 + 1)}`);
    const result = await adapter().callStream(request, "test");
    await expect(result.stream![Symbol.asyncIterator]().next()).rejects.toThrow("size limit");
    expect(source.cancel).toHaveBeenCalledOnce();
    source = mockBody('"oversized JSON"');
    const small = new OpenAIAdapter({
      baseUrl: "https://provider.invalid",
      apiKey: "test",
      maxResponseBytes: 4,
    });
    await expect(small.call(request, "test")).rejects.toThrow("exceeds 4 bytes");
    expect(source.cancel).toHaveBeenCalledOnce();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("x".repeat(128 * 1024)));
            },
            cancel,
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(adapter().call(request, "test")).rejects.toHaveProperty(
      "responseBody",
      "x".repeat(64 * 1024),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reads fragmented UTF-8 mixed with many empty chunks within a byte cap", async () => {
    const expected = "内存".repeat(1000);
    const encoded = encoder.encode(expected);
    let index = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(0));
          if (index === encoded.length) controller.close();
          else controller.enqueue(encoded.slice(index, ++index));
        },
      }),
    );
    expect(await readBoundedText(response, encoded.length, new AbortController().signal)).toBe(
      expected,
    );
  });

  it("enforces the error-body prefix cap across one-byte chunks", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads++;
          controller.enqueue(encoder.encode("x"));
        },
        cancel,
      }),
    );
    expect(await readBoundedText(response, 32, new AbortController().signal, true)).toBe(
      "x".repeat(32),
    );
    expect(reads).toBeLessThan(36);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
