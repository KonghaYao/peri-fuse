import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

function errorBatch(traceId: string, signature: string, timestamp: string, count: number) {
  return [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp,
      body: { id: traceId, timestamp, name: "failing-trace" },
    },
    ...Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      type: "generation-create",
      timestamp,
      body: {
        id: `error-${randomUUID()}`,
        traceId,
        name: `database-call-${index}`,
        startTime: new Date(new Date(timestamp).getTime() + index).toISOString(),
        level: "ERROR",
        statusMessage: signature,
        model: "test-model",
        input: "must-not-appear-in-index",
      },
    })),
  ];
}

describe("GET /api/public/errors", () => {
  it("summarizes, paginates and project-scopes lightweight error records", async () => {
    const signature = `connection refused ${randomUUID()}`;
    const traceId = `error-trace-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const ingestion = await apiPost("/api/public/ingestion", {
      batch: errorBatch(traceId, signature, timestamp, 2),
    });
    expect(ingestion.status).toBe(207);

    const second = await createSecondProject();
    const hidden = await apiPost(
      "/api/public/ingestion",
      { batch: errorBatch(`hidden-${randomUUID()}`, signature, timestamp, 1) },
      {},
      second.auth,
    );
    expect(hidden.status).toBe(207);

    const first = await apiGet<any>(
      `/api/public/errors?search=${encodeURIComponent(signature)}&limit=1`,
    );
    expect(first.status).toBe(200);
    expect(first.body.summary).toMatchObject({
      totalErrors: 2,
      affectedTraces: 1,
      uniqueSignatures: 1,
    });
    expect(first.body.groups[0]).toMatchObject({ signature, count: 2, traceCount: 1 });
    expect(first.body.models[0]).toMatchObject({ model: "test-model", count: 2 });
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0].startTime).toMatch(/Z$/);
    expect(first.body.data[0]).not.toHaveProperty("input");
    expect(first.body.meta.cursor).toEqual(expect.any(String));

    const secondPage = await apiGet<any>(
      `/api/public/errors?search=${encodeURIComponent(signature)}&limit=1&cursor=${encodeURIComponent(first.body.meta.cursor)}`,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(secondPage.body.meta.cursor).toBeNull();
  });

  it("rejects malformed cursors", async () => {
    const result = await apiGet("/api/public/errors?cursor=not-a-cursor");
    expect(result.status).toBe(400);
  });
});
