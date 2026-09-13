import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEnv } from "../src/app.js";
import { parallelLimiterHook } from "../src/hooks/parallel-limiter.js";
import { hookRegistry } from "../src/hooks/registry.js";
import type { PeriStreamChunk } from "../src/protocol/types.js";
import { OpenAIAdapter } from "../src/provider/openai.js";
import chat from "../src/routes/proxy/chat.js";
import messages from "../src/routes/proxy/messages.js";

const mocks = vi.hoisted(() => ({ route: vi.fn(), enqueue: vi.fn(), assertWritable: vi.fn() }));
vi.mock("../src/router/index.js", () => ({
  routeRequest: mocks.route,
  RouterError: class extends Error {},
}));
vi.mock("../src/spend/flusher.js", () => ({
  spendFlusher: { enqueue: mocks.enqueue, assertWritable: mocks.assertWritable },
  SpendWriteError: class extends Error {},
}));
const failed = vi.fn().mockResolvedValue(undefined);
const succeeded = vi.fn().mockResolvedValue(undefined);
const deployment = {
  id: "model",
  providerId: "provider",
  providerModel: "test",
  providerName: "test",
  baseUrl: "http://test",
  modelInfo: {},
};
const chunk: PeriStreamChunk = {
  id: "1",
  model: "test",
  delta: { content: "hello" },
  finishReason: null,
};
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function app() {
  const app = new Hono<GatewayEnv>();
  app.use("*", async (c, next) => {
    c.set("projectId", "project-a");
    c.set("apiKeyId", "key-a");
    c.set("apiKeyPrefix", "pk-a");
    await next();
  });
  app.route("/", chat);
  app.route("/", messages);
  return app;
}
function init(signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [], stream: true }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertWritable.mockReset();
  mocks.enqueue.mockReset();
  hookRegistry.register(parallelLimiterHook);
  hookRegistry.register({ name: "test-observer", postSuccess: succeeded, postFailure: failed });
});
afterEach(() => {
  hookRegistry.unregister("parallel-limiter");
  hookRegistry.unregister("test-observer");
  vi.unstubAllGlobals();
});

describe.each(["/v1/chat/completions", "/v1/messages"])("%s lifecycle", (path) => {
  it("reports midstream failure once and cancels the upstream", async () => {
    const cancel = vi.fn();
    mocks.route.mockResolvedValue({
      deployment,
      usage,
      cancel,
      stream: (async function* () {
        yield chunk;
        throw new Error("upstream disconnected");
      })(),
    });
    const response = await app().request(path, init());
    expect(await response.text()).toContain("upstream disconnected");
    expect(failed).toHaveBeenCalledOnce();
    expect(succeeded).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("cancels a pending upstream read when the client cancels the response body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
                ),
              );
            },
            cancel,
          }),
        ),
      ),
    );
    mocks.route.mockImplementation(async (req, _project, _strategy, signal: AbortSignal) => ({
      ...(await new OpenAIAdapter({ baseUrl: "http://test", apiKey: "key", signal }).callStream(
        req,
        "test",
      )),
      deployment,
    }));
    const response = await app().request(path, init());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    expect(succeeded).not.toHaveBeenCalled();
  });

  it("unblocks a stalled SSE write when the request aborts", async () => {
    const client = new AbortController();
    const cancel = vi.fn();
    mocks.route.mockResolvedValue({
      deployment,
      usage,
      cancel,
      stream: (async function* () {
        yield chunk;
        yield chunk;
        yield chunk;
      })(),
    });
    const response = await app().request(path, init(client.signal));
    client.abort();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalled();
    await response.body!.cancel();
  });

  it("reports accounting failures before sending the terminal success event", async () => {
    mocks.enqueue.mockImplementation(() => {
      throw new Error("accounting unavailable");
    });
    mocks.route.mockResolvedValue({
      deployment,
      usage,
      cancel: vi.fn(),
      stream: (async function* () {
        yield chunk;
      })(),
    });
    const response = await app().request(path, init());
    const body = await response.text();
    expect(body).toContain("accounting unavailable");
    expect(body).not.toContain("[DONE]");
    expect(body).not.toContain("message_stop");
    expect(failed).toHaveBeenCalledOnce();
    expect(succeeded).not.toHaveBeenCalled();
  });
});
