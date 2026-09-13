import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

type SessionPage = {
  createdAt: string;
  countTraces: number;
  totalTokens: number;
  totalCost: number;
  sessionDuration: number;
  traces: Array<{ id: string; observations: unknown[]; totalTokens: number; totalCost: number }>;
  meta?: { totalItems: number; totalPages: number; page: number; limit: number };
};

describe("session trace pagination", () => {
  it("pages traces while keeping summary metrics across the complete session", async () => {
    // Historical traces must not enter the global project's all-time dashboard fixtures.
    const project = await createSecondProject();
    const get = (path: string) => apiGet<SessionPage>(path, project.auth);
    const sessionId = `paged-session-${randomUUID()}`;
    const traceIds = Array.from({ length: 3 }, () => randomUUID());
    const batch = traceIds.flatMap((id, index) => {
      const timestamp = new Date(Date.UTC(2026, 8, 1, 12, index)).toISOString();
      return [
        { id: randomUUID(), type: "trace-create", timestamp, body: { id, sessionId, timestamp } },
        {
          id: randomUUID(),
          type: "generation-create",
          timestamp,
          body: {
            id: randomUUID(),
            traceId: id,
            startTime: timestamp,
            model: "memory-pagination-model",
            usage: { input: 2, output: 1, total: 3 },
            costDetails: { input: 0.01, output: 0.02, total: 0.03 },
          },
        },
      ];
    });
    expect((await apiPost("/api/public/ingestion", { batch }, {}, project.auth)).status).toBe(207);
    const base = `/api/public/sessions/${sessionId}`;
    const legacy = await get(base);
    const first = await get(`${base}?page=1&limit=2&includeObservations=false&includeIo=false`);
    const second = await get(`${base}?page=2&limit=2&includeObservations=false&includeIo=false`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(legacy.body.traces).toHaveLength(3);
    expect(legacy.body.traces.every((trace) => trace.observations.length === 1)).toBe(true);
    expect(first.body.traces.map((trace) => trace.id)).toEqual(traceIds.slice(0, 2));
    expect(second.body.traces.map((trace) => trace.id)).toEqual(traceIds.slice(2));
    for (const body of [first.body, second.body]) {
      expect(body.countTraces).toBe(3);
      expect(body.createdAt).toBe(legacy.body.createdAt);
      expect(body.sessionDuration).toBe(120);
      expect(body.totalTokens).toBe(9);
      expect(body.totalCost).toBeCloseTo(legacy.body.totalCost);
      expect(body.meta).toMatchObject({ totalItems: 3, totalPages: 2, limit: 2 });
      expect(body.traces.every((trace) => trace.observations.length === 0)).toBe(true);
    }
    const beyond = await get(`${base}?page=3&limit=2`);
    expect(beyond.status).toBe(200);
    expect(beyond.body.traces).toEqual([]);
    expect(beyond.body.countTraces).toBe(3);
    expect((await get(`${base}?page=0`)).status).toBe(400);
    expect((await get(`${base}?limit=501`)).status).toBe(400);
  });
});
