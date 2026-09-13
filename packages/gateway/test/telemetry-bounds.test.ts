import { afterEach, describe, expect, it, vi } from "vitest";
import { periFuseLoggerHook, periFuseLoggerStats } from "../src/hooks/peri-fuse-logger.js";
import type { CallResult, HookContext } from "../src/hooks/types.js";
import { BoundedTtlMap } from "../src/utils/bounded-ttl-map.js";
import { logSnapshot } from "../src/utils/log-snapshot.js";

vi.mock("../src/env.js", () => ({
  gatewayEnv: {
    perifuseEndpoint: "http://logger.invalid",
    perifusePublicKey: "pk-logger",
    perifuseSecretKey: "sk-logger",
    logRequests: true,
    logMaxBodySize: 1024,
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Bounded process caches and reporting", () => {
  it("evicts at capacity and actively removes untouched expired keys", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlMap<number>(2, 100);
    cache.set("project-a", 1);
    cache.set("project-b", 2);
    cache.set("project-c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("project-a")).toBeUndefined();
    expect(cache.get("project-b")).toBe(2);
    vi.advanceTimersByTime(101);
    expect(cache.size).toBe(0);
    cache.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("copies only bounded telemetry, including large arrays and circular metadata", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const output = logSnapshot({ input: Array(10_000).fill("x".repeat(10_000)), cyclic }, 1024);
    expect(JSON.stringify(output).length).toBeLessThan(1500);
    expect(JSON.stringify(output)).toContain("truncated");
    expect(JSON.stringify(logSnapshot(cyclic, 1024))).toContain("circular");
    expect(JSON.stringify(logSnapshot("x".repeat(100_000), NaN)).length).toBeLessThan(11000);
  });

  it("caps in-flight reports, bounds IO and cancels each response body", async () => {
    const resolve: ((value: Response) => void)[] = [];
    const fetchMock = vi.fn(
      (_url, _init: RequestInit) => new Promise<Response>((r) => resolve.push(r)),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx: HookContext = {
      projectId: "project-a",
      apiKey: {
        id: "key-a",
        publicKey: "pk-a",
        spend: 0,
        models: [],
        maxParallel: null,
        tpmLimit: null,
        rpmLimit: null,
        maxBudget: null,
        budgetId: null,
        metadata: {},
      },
      model: "test",
      protocol: "openai",
      callType: "chat",
      stream: false,
      startTime: new Date(),
      metadata: { projectId: "project-b", large: "x".repeat(100_000) },
      messages: ["x".repeat(100_000)],
    };
    const result: CallResult = {
      response: "y".repeat(100_000),
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      spend: 1,
      latencyMs: 1,
      providerId: "provider",
      providerModel: "test",
      apiBase: "http://test",
    };
    const reports = Array.from({ length: 100 }, () => periFuseLoggerHook.postSuccess!(ctx, result));
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(periFuseLoggerStats()).toEqual({ activeReports: 8, droppedReports: 92 });
    for (const [, init] of fetchMock.mock.calls) {
      const body = String(init.body);
      expect(Buffer.byteLength(body)).toBeLessThan(8192);
      expect(JSON.parse(body).batch[0].body.metadata.projectId).toBe("project-a");
      expect(body).toContain("truncated");
    }
    const cancel = vi.fn();
    for (const r of resolve) r(new Response(new ReadableStream({ cancel })));
    await Promise.all(reports);
    expect(cancel).toHaveBeenCalledTimes(8);
    expect(periFuseLoggerStats().activeReports).toBe(0);
    vi.restoreAllMocks();
  });
});
