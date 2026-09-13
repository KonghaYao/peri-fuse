import { describe, expect, it, vi } from "vitest";
import { parallelLimiterHook } from "../src/hooks/parallel-limiter.js";
import { rateLimiterHook } from "../src/hooks/rate-limiter.js";
import { HookRegistry } from "../src/hooks/registry.js";
import type { CallResult, HookContext } from "../src/hooks/types.js";

function context(projectId = "project-a", id = crypto.randomUUID()): HookContext {
  return {
    projectId,
    apiKey: {
      id,
      publicKey: "pk-test",
      spend: 0,
      models: [],
      maxParallel: 1,
      tpmLimit: null,
      rpmLimit: 1,
      maxBudget: null,
      budgetId: null,
      metadata: {},
    },
    model: "test",
    protocol: "openai",
    callType: "chat",
    stream: true,
    startTime: new Date(),
    metadata: {},
  };
}
const result: CallResult = {
  response: null,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  spend: 0,
  latencyMs: 1,
  providerId: "provider",
  providerModel: "test",
  apiBase: "http://test",
};

describe("Hook acquisition and completion", () => {
  it("unwinds a parallel slot when a later RPM check rejects", async () => {
    const registry = new HookRegistry();
    registry.register(parallelLimiterHook);
    registry.register(rateLimiterHook);
    const first = context();
    await registry.runPreCall(first);
    registry.runPostSuccess(first, result);
    const rejected = context(first.projectId, first.apiKey.id);
    await expect(registry.runPreCall(rejected)).rejects.toThrow("Rate limit");
    const next = context(first.projectId, first.apiKey.id);
    next.apiKey.rpmLimit = null;
    await expect(registry.runPreCall(next)).resolves.toBeUndefined();
    registry.runPostFailure(next, new Error("cleanup"));
  });

  it("a rejected parallel check cannot release another request, and cleanup is once", async () => {
    const registry = new HookRegistry();
    registry.register(parallelLimiterHook);
    const success = vi.fn().mockResolvedValue(undefined);
    const failure = vi.fn().mockResolvedValue(undefined);
    registry.register({ name: "report", postSuccess: success, postFailure: failure });
    const first = context();
    await registry.runPreCall(first);
    await expect(registry.runPreCall(context(first.projectId, first.apiKey.id))).rejects.toThrow(
      "Parallel",
    );
    await expect(registry.runPreCall(context(first.projectId, first.apiKey.id))).rejects.toThrow(
      "Parallel",
    );
    registry.runPostSuccess(first, result);
    const second = context(first.projectId, first.apiKey.id);
    await registry.runPreCall(second);
    registry.runPostFailure(first, new Error("duplicate"));
    await expect(registry.runPreCall(context(first.projectId, first.apiKey.id))).rejects.toThrow(
      "Parallel",
    );
    registry.runPostFailure(second, new Error("cleanup"));
    expect(success).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
  });

  it("isolates parallel and RPM counters even with identical key ids across projects", async () => {
    const registry = new HookRegistry();
    registry.register(parallelLimiterHook);
    registry.register(rateLimiterHook);
    const first = context();
    const other = context("project-b", first.apiKey.id);
    await registry.runPreCall(first);
    await expect(registry.runPreCall(other)).resolves.toBeUndefined();
    registry.runPostFailure(first, new Error("cleanup"));
    registry.runPostFailure(other, new Error("cleanup"));
  });
});
