import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SpendEvent } from "../src/spend/flusher.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
} from "./helpers/admin-test-harness.js";

function spendEvent(
  apiKey: string,
  status: "success" | "error",
  promptTokens: number,
  completionTokens: number,
  spend: number,
): SpendEvent {
  const startTime = new Date("2026-08-28T01:00:00.000Z");
  return {
    projectId: PROJECT_A,
    callType: "completion",
    apiKey,
    spend,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    startTime,
    endTime: new Date(startTime.getTime() + 100),
    model: "batch-count-model",
    provider: "batch-count-provider",
    status,
  };
}

describe("DailySpend batch aggregation", () => {
  let harness: AdminTestHarness;
  let spendFlusher: typeof import("../src/spend/flusher.js").spendFlusher;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
    ({ spendFlusher } = await import("../src/spend/flusher.js"));
    spendFlusher.stop();
    await spendFlusher.flushAll();
  });

  afterEach(async () => {
    await spendFlusher.flushAll();
  });

  afterAll(async () => {
    spendFlusher.stop();
    await spendFlusher.flushAll();
    await harness.close();
  });

  it("reports every request when a batch creates a daily spend row", async () => {
    const apiKey = "batch-insert-key";
    spendFlusher.enqueue(spendEvent(apiKey, "success", 10, 1, 0.1));
    spendFlusher.enqueue(spendEvent(apiKey, "success", 20, 2, 0.2));
    spendFlusher.enqueue(spendEvent(apiKey, "success", 30, 3, 0.3));

    await spendFlusher.flushDaily();
    const summary = await harness.request("A", "GET", `/admin/usage/summary?apiKey=${apiKey}`);

    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      totalPromptTokens: 60,
      totalCompletionTokens: 6,
      totalRequests: 3,
      successfulRequests: 3,
      failedRequests: 0,
    });
    expect(summary.body.totalSpend).toBeCloseTo(0.6);
  });

  it("adds every request when a batch updates a daily spend row", async () => {
    const apiKey = "batch-update-key";
    spendFlusher.enqueue(spendEvent(apiKey, "success", 5, 1, 0.05));
    await spendFlusher.flushDaily();

    spendFlusher.enqueue(spendEvent(apiKey, "success", 10, 2, 0.1));
    spendFlusher.enqueue(spendEvent(apiKey, "success", 20, 4, 0.2));
    await spendFlusher.flushDaily();

    const summary = await harness.request("A", "GET", `/admin/usage/summary?apiKey=${apiKey}`);

    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      totalPromptTokens: 35,
      totalCompletionTokens: 7,
      totalRequests: 3,
      successfulRequests: 3,
      failedRequests: 0,
    });
    expect(summary.body.totalSpend).toBeCloseTo(0.35);
  });

  it("keeps both outcome counts when an update batch has mixed statuses", async () => {
    const apiKey = "batch-mixed-status-key";
    spendFlusher.enqueue(spendEvent(apiKey, "success", 1, 1, 0.01));
    await spendFlusher.flushDaily();

    spendFlusher.enqueue(spendEvent(apiKey, "error", 2, 2, 0.02));
    spendFlusher.enqueue(spendEvent(apiKey, "success", 3, 3, 0.03));
    spendFlusher.enqueue(spendEvent(apiKey, "error", 4, 4, 0.04));
    await spendFlusher.flushDaily();

    const summary = await harness.request("A", "GET", `/admin/usage/summary?apiKey=${apiKey}`);

    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      totalPromptTokens: 10,
      totalCompletionTokens: 10,
      totalRequests: 4,
      successfulRequests: 2,
      failedRequests: 2,
    });
    expect(summary.body.totalSpend).toBeCloseTo(0.1);
  });
});
