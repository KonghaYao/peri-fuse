/**
 * Query-filter integration tests for traces, observations, and scores.
 *
 * Seeds two distinct traces (with observations and scores) through the
 * ingestion API, then verifies each supported filter dimension — including
 * negative cases — returns exactly the expected rows.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";

const runId = randomUUID();

const traceA = `f-trace-a-${runId}`;
const traceB = `f-trace-b-${runId}`;
const userA = `f-user-a-${runId}`;
const userB = `f-user-b-${runId}`;
const sessionA = `f-session-a-${runId}`;
const sessionB = `f-session-b-${runId}`;
const nameA = `f-trace-alpha-${runId}`;
const nameB = `f-trace-beta-${runId}`;
const tagA = `f-tag-x-${runId}`;
const tagB = `f-tag-y-${runId}`;
const literalTag = `literal_%"-${runId}`;
const scoreAlpha = `f-score-alpha-${runId}`;
const scoreBeta = `f-score-beta-${runId}`;

const iso = new Date().toISOString();

describe("public API filters", () => {
  beforeAll(async () => {
    const res = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: {
            id: traceA,
            timestamp: iso,
            name: nameA,
            userId: userA,
            sessionId: sessionA,
            tags: [tagA, literalTag],
            environment: "production",
            version: "filter-v1",
            release: "filter-release-a",
          },
        },
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: {
            id: traceB,
            timestamp: iso,
            name: nameB,
            userId: userB,
            sessionId: sessionB,
            tags: [tagB],
            environment: "staging",
          },
        },
        {
          id: randomUUID(),
          type: "generation-create",
          timestamp: iso,
          body: {
            id: `f-gen-${runId}`,
            traceId: traceA,
            name: `f-gen-${runId}`,
            startTime: iso,
            model: "gpt-4o",
            version: "filter-v1",
          },
        },
        {
          id: randomUUID(),
          type: "span-create",
          timestamp: iso,
          body: {
            id: `f-span-${runId}`,
            traceId: traceA,
            name: `f-span-${runId}`,
            parentObservationId: `f-gen-${runId}`,
            startTime: iso,
            input: { prompt: "large detail stays behind the detail endpoint" },
            output: { result: "not needed in the observations table" },
            metadata: { privateContext: "not part of a list summary" },
          },
        },
        {
          id: randomUUID(),
          type: "event-create",
          timestamp: iso,
          body: {
            id: `f-error-${runId}`,
            traceId: traceA,
            name: `f-error-${runId}`,
            level: "ERROR",
            statusMessage: "boom",
            startTime: iso,
          },
        },
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: iso,
          body: {
            id: randomUUID(),
            traceId: traceA,
            name: scoreAlpha,
            value: 1,
            dataType: "NUMERIC",
          },
        },
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: iso,
          body: {
            id: randomUUID(),
            traceId: traceB,
            name: scoreBeta,
            value: 0,
            dataType: "NUMERIC",
          },
        },
      ],
    });
    expect(res.status).toBe(207);
    expect(res.body.errors).toEqual([]);
  });

  describe("observations", () => {
    it("filters by model before pagination and counts only matching rows", async () => {
      const res = await apiGet(`/api/public/observations?traceId=${traceA}&model=gpt-4o&limit=1`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([`f-gen-${runId}`]);
      expect(res.body.meta.totalItems).toBe(1);
      expect(res.body.meta.totalPages).toBe(1);
      const next = await apiGet(
        `/api/public/observations?traceId=${traceA}&model=gpt-4o&limit=1&page=2`,
      );
      expect(next.body.data).toEqual([]);
      expect(next.body.meta.totalItems).toBe(1);
    });

    it("combines model, user and version filters", async () => {
      const res = await apiGet(
        `/api/public/observations?userId=${userA}&model=gpt-4o&version=filter-v1`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([`f-gen-${runId}`]);
      const mismatch = await apiGet(
        `/api/public/observations?userId=${userB}&model=gpt-4o&version=filter-v1`,
      );
      expect(mismatch.body.data).toEqual([]);
      expect(mismatch.body.meta.totalItems).toBe(0);
    });

    it("matches model exactly and rejects unknown models with an empty result", async () => {
      const res = await apiGet(`/api/public/observations?traceId=${traceA}&model=gpt`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.totalItems).toBe(0);
    });

    it("filters by parent observation", async () => {
      const res = await apiGet(
        `/api/public/observations?traceId=${traceA}&parentObservationId=f-gen-${runId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([`f-span-${runId}`]);
      expect(res.body.meta.totalItems).toBe(1);
    });

    it("filters by type", async () => {
      const res = await apiGet(`/api/public/observations?traceId=${traceA}&type=GENERATION`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe(`f-gen-${runId}`);
    });

    it("filters by name", async () => {
      const res = await apiGet(`/api/public/observations?traceId=${traceA}&name=f-span-${runId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].type).toBe("SPAN");
    });

    it("returns a lightweight summary only when explicitly requested", async () => {
      const res = await apiGet(
        `/api/public/observations?traceId=${traceA}&name=f-span-${runId}&fields=summary`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: `f-span-${runId}`,
        traceId: traceA,
        name: `f-span-${runId}`,
        type: "SPAN",
      });
      expect(res.body.data[0]).not.toHaveProperty("input");
      expect(res.body.data[0]).not.toHaveProperty("output");
      expect(res.body.data[0]).not.toHaveProperty("metadata");
    });

    it("filters by level", async () => {
      const res = await apiGet(`/api/public/observations?traceId=${traceA}&level=ERROR`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe(`f-error-${runId}`);
      expect(res.body.data[0].level).toBe("ERROR");
    });

    it("returns nothing for a future fromStartTime", async () => {
      const res = await apiGet(
        `/api/public/observations?traceId=${traceA}&fromStartTime=2099-01-01T00:00:00Z`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it("returns everything for a past fromStartTime", async () => {
      const res = await apiGet(
        `/api/public/observations?traceId=${traceA}&fromStartTime=2000-01-01T00:00:00Z`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });
  });

  describe("traces", () => {
    it("requires every tag supplied through repeated query parameters", async () => {
      const res = await apiGet(
        `/api/public/traces?tags=${tagA}&tags=${encodeURIComponent(literalTag)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([traceA]);
      const mismatch = await apiGet(`/api/public/traces?tags=${tagA}&tags=${tagB}`);
      expect(mismatch.body.data).toEqual([]);
      expect(mismatch.body.meta.totalItems).toBe(0);
    });

    it("matches tags with literal wildcard and JSON quote characters", async () => {
      const res = await apiGet(`/api/public/traces?tags=${encodeURIComponent(literalTag)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([traceA]);
      expect(res.body.meta.totalItems).toBe(1);
      const partial = await apiGet(
        `/api/public/traces?tags=${encodeURIComponent(literalTag.slice(0, 9))}`,
      );
      expect(partial.body.data).toEqual([]);
    });

    it("combines session, tag, version and release filters before pagination", async () => {
      const res = await apiGet(
        `/api/public/traces?sessionId=${sessionA}&tags=${tagA}&version=filter-v1&release=filter-release-a&limit=1`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([traceA]);
      expect(res.body.meta.totalItems).toBe(1);
      const mismatch = await apiGet(`/api/public/traces?sessionId=${sessionB}&version=filter-v1`);
      expect(mismatch.body.data).toEqual([]);
    });

    it("filters by userId", async () => {
      const res = await apiGet(`/api/public/traces?userId=${userA}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(traceA);
    });

    it("filters by sessionId", async () => {
      const res = await apiGet(`/api/public/traces?sessionId=${sessionB}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(traceB);
    });

    it("filters by name", async () => {
      const res = await apiGet(`/api/public/traces?name=${nameA}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(traceA);
    });

    it("filters by tags", async () => {
      const res = await apiGet(`/api/public/traces?tags=${tagB}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(traceB);
    });

    it("filters by environment", async () => {
      const res = await apiGet(`/api/public/traces?environment=staging`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(traceB);
      expect(ids).not.toContain(traceA);
    });

    it("returns nothing for an unknown userId", async () => {
      const res = await apiGet(`/api/public/traces?userId=nonexistent-${runId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.totalItems).toBe(0);
    });
  });

  describe("scores", () => {
    it("combines numeric threshold and trace-user filters", async () => {
      const res = await apiGet(`/api/public/scores?userId=${userA}&operator=%3E%3D&value=1`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((row: { name: string }) => row.name)).toContain(scoreAlpha);
      expect(res.body.data.map((row: { name: string }) => row.name)).not.toContain(scoreBeta);
      const zero = await apiGet(`/api/public/scores?name=${scoreBeta}&operator=%3D&value=0`);
      expect(zero.status).toBe(200);
      expect(zero.body.data).toHaveLength(1);
      expect(zero.body.meta.totalItems).toBe(1);
    });

    it("filters by traceId", async () => {
      const res = await apiGet(`/api/public/scores?traceId=${traceA}`);
      expect(res.status).toBe(200);
      const names = res.body.data.map((s: any) => s.name);
      expect(names).toContain(scoreAlpha);
      expect(names).not.toContain(scoreBeta);
    });

    it("filters by name", async () => {
      const res = await apiGet(`/api/public/scores?name=${scoreBeta}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].traceId).toBe(traceB);
    });

    it("supports advanced filter JSON on traceId", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([{ type: "string", column: "traceId", operator: "=", value: traceB }]),
      );
      const res = await apiGet(`/api/public/scores?filter=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const s of res.body.data) {
        expect(s.traceId).toBe(traceB);
      }
    });
  });
});
