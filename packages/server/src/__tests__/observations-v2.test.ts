/**
 * Integration tests for GET /api/public/v2/observations.
 *
 * Seeds one trace with five observations (three sharing an identical
 * start_time, two roots without a physical parent) through the ingestion
 * API, then verifies cursor pagination, field-group selection,
 * expandMetadata truncation, parseIoAsJson, and the extended filter
 * pipeline (boolean / null types).
 *
 * The v2 route is mounted on a standalone Hono instance (it is not part of
 * createApp yet), while seeding goes through the real ingestion route.
 */
import { randomUUID } from "node:crypto";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiteServerEnv } from "../auth";
import observationsV2Routes from "../routes/observations-v2";
import { buildObservationsV2Select } from "../shaping/observations-v2";
import { apiPost, basicAuth } from "./helpers";
import { TEST_PROJECT_ID } from "./test-db-paths";

const runId = randomUUID();
const traceId = `v2-obs-trace-${runId}`;
const root1 = `v2-obs-root1-${runId}`;
const child1 = `v2-obs-child1-${runId}`;
const child2 = `v2-obs-child2-${runId}`;
const root2 = `v2-obs-root2-${runId}`;
const late = `v2-obs-late-${runId}`;

// Second trace (different session/tags/name) for trace-property filter tests.
const traceB = `v2-obs-trace-b-${runId}`;
const obsB = `v2-obs-b-${runId}`;

const T1 = "2026-01-01T00:00:00.000Z"; // shared by root1/child1/child2
const T2 = "2025-01-01T00:00:00.000Z"; // root2 (oldest)
const T3 = "2027-01-01T00:00:00.000Z"; // late (newest)

const allObservationIds = [root1, child1, child2, root2, late];
const rootObservationIds = [root1, root2];

let app: Hono<LiteServerEnv> | null = null;
function getV2App(): Hono<LiteServerEnv> {
  if (!app) {
    app = new Hono<LiteServerEnv>();
    // Same error mapping as app.ts: BaseError subclasses (e.g.
    // InvalidRequestError from the filter pipeline) map to their HTTP code.
    app.onError((err, c) => {
      if (err instanceof LangfuseNotFoundError) {
        return c.json({ message: err.message }, 404);
      }
      if (err instanceof BaseError) {
        return c.json({ error: err.name, message: err.message }, err.httpCode as 500);
      }
      return c.json({ message: "Internal Server Error" }, 500);
    });
    app.route("/", observationsV2Routes);
  }
  return app;
}

async function v2Get<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await getV2App().request(path, {
    headers: { Authorization: basicAuth() },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET /api/public/v2/observations", () => {
  beforeAll(async () => {
    const timestamp = new Date().toISOString();
    const res = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp,
          body: {
            id: traceId,
            timestamp,
            name: "v2-trace",
            userId: "v2-user",
            sessionId: "v2-session",
            tags: ["alpha", "beta"],
            environment: "production",
          },
        },
        {
          id: randomUUID(),
          type: "generation-create",
          timestamp,
          body: {
            id: root1,
            traceId,
            name: "root-gen",
            startTime: T1,
            environment: "production",
            input: { role: "user", content: "hi" },
            output: { role: "assistant", content: "yo" },
            usage: { input: 10, output: 20, total: 30 },
            metadata: { longKey: "x".repeat(300), shortKey: "short" },
          },
        },
        {
          id: randomUUID(),
          type: "span-create",
          timestamp,
          body: {
            id: child1,
            traceId,
            parentObservationId: root1,
            name: "child-span",
            startTime: T1,
          },
        },
        {
          id: randomUUID(),
          type: "span-create",
          timestamp,
          body: {
            id: child2,
            traceId,
            parentObservationId: root1,
            name: "child2-span",
            startTime: T1,
          },
        },
        {
          id: randomUUID(),
          type: "generation-create",
          timestamp,
          body: {
            id: root2,
            traceId,
            name: "older-gen",
            startTime: T2,
          },
        },
        {
          id: randomUUID(),
          type: "event-create",
          timestamp,
          body: {
            id: late,
            traceId,
            parentObservationId: root2,
            name: "late-event",
            startTime: T3,
            level: "ERROR",
          },
        },
      ],
    });
    expect(res.status).toBe(207);
    expect(res.body.errors).toEqual([]);
  });

  describe("cursor pagination", () => {
    it("pages through rows with identical start_time without overlap or gaps", async () => {
      const collected: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url = `/api/public/v2/observations?limit=2&traceId=${traceId}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`;
        const res = await v2Get<{ data: { id: string }[]; meta: { cursor: string | null } }>(url);
        expect(res.status).toBe(200);
        collected.push(...res.body.data.map((d) => d.id));
        cursor = res.body.meta.cursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(5);
      } while (cursor !== null);

      expect(pages).toBe(3);
      expect(collected).toHaveLength(5);
      expect(new Set(collected)).toEqual(new Set(allObservationIds));
    });

    it("returns null cursor when all rows fit in one page", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&traceId=${traceId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.meta.cursor).toBeNull();
    });

    it("orders rows by start_time DESC with id as tiebreaker", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&traceId=${traceId}`);
      const ids = res.body.data.map((d: any) => d.id);
      expect(ids[0]).toBe(late); // 2027
      expect(ids[4]).toBe(root2); // 2025
      // The three 2026 rows must all sit between the 2027 and 2025 rows.
      const mid = new Set(ids.slice(1, 4));
      expect(mid).toEqual(new Set([root1, child1, child2]));
    });

    it("rejects a malformed cursor with 400", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?cursor=not-a-cursor`);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Invalid cursor");
    });

    it("rejects a cursor with an invalid payload shape with 400", async () => {
      const bogus = Buffer.from(JSON.stringify({ v: 2, lastStartTime: "x", lastId: "y" })).toString(
        "base64url",
      );
      const res = await v2Get<any>(`/api/public/v2/observations?cursor=${bogus}`);
      expect(res.status).toBe(400);
    });

    it("rejects limit above 1000 with 400", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?limit=1001`);
      expect(res.status).toBe(400);
    });

    it("rejects limit below 1 with 400", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?limit=0`);
      expect(res.status).toBe(400);
    });
  });

  describe("field groups", () => {
    it("does not select large IO or metadata columns for lightweight pages", () => {
      const sql = buildObservationsV2Select(new Set(["core", "basic", "usage"]));

      expect(sql).not.toContain("o.input");
      expect(sql).not.toContain("o.output");
      expect(sql).not.toContain("o.metadata");
      expect(sql).toContain("o.usage_details");
      expect(sql).toContain("o.id");
    });

    it("selects IO and metadata only when explicitly requested", () => {
      const sql = buildObservationsV2Select(new Set(["core", "io", "metadata"]));

      expect(sql).toContain("o.input");
      expect(sql).toContain("o.output");
      expect(sql).toContain("o.metadata");
    });

    it("defaults to core + basic", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&traceId=${traceId}`);
      const row = res.body.data.find((d: any) => d.id === root1);
      expect(row.name).toBe("root-gen");
      expect(row.userId).toBe("v2-user");
      expect(row.sessionId).toBe("v2-session");
      expect(row.isRootObservation).toBe(true);
      expect(row.level).toBe("DEFAULT");
      // core fields always present
      expect(row.id).toBe(root1);
      expect(row.traceId).toBe(traceId);
      expect(row.projectId).toBeDefined();
      expect(row.parentObservationId).toBeNull();
      expect(row.type).toBe("GENERATION");
      expect(row.modelId).toBeNull();
      expect(row.inputPrice).toBeNull();
      // groups not requested are absent
      expect(row.input).toBeUndefined();
      expect(row.metadata).toBeUndefined();
      expect(row.latency).toBeUndefined();
    });

    it("selects only the requested field groups", async () => {
      const res = await v2Get<any>(
        `/api/public/v2/observations?limit=100&fields=io,model&traceId=${traceId}`,
      );
      const row = res.body.data.find((d: any) => d.id === root1);
      expect(row.input).toBeDefined();
      expect(row.output).toBeDefined();
      expect(row.providedModelName).toBeNull();
      // model_parameters defaults to '{}' in SQLite → parsed to an empty object
      expect(row.modelParameters).toEqual({});
      // basic/time/usage/prompt/metrics groups absent
      expect(row.name).toBeUndefined();
      expect(row.level).toBeUndefined();
      expect(row.userId).toBeUndefined();
      expect(row.createdAt).toBeUndefined();
      expect(row.usageDetails).toBeUndefined();
      expect(row.latency).toBeUndefined();
    });

    it("rejects unknown field groups with 400", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?fields=bogus`);
      expect(res.status).toBe(400);
    });
  });

  describe("expandMetadata", () => {
    it("truncates metadata values over 200 chars by default", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?fields=metadata&name=root-gen`);
      expect(res.status).toBe(200);
      const row = res.body.data[0];
      expect(row.metadata.longKey).toBe(`${"x".repeat(200)}...`);
      expect(row.metadata.shortKey).toBe("short");
    });

    it("returns full values for expanded keys", async () => {
      const res = await v2Get<any>(
        `/api/public/v2/observations?fields=metadata&expandMetadata=longKey&name=root-gen`,
      );
      expect(res.status).toBe(200);
      const row = res.body.data[0];
      expect(row.metadata.longKey).toBe("x".repeat(300));
    });

    it("expandMetadata=true expands every key", async () => {
      const res = await v2Get<any>(
        `/api/public/v2/observations?fields=metadata&expandMetadata=true&name=root-gen`,
      );
      expect(res.status).toBe(200);
      const row = res.body.data[0];
      expect(row.metadata.longKey).toBe("x".repeat(300));
    });
  });

  describe("filter", () => {
    beforeAll(async () => {
      // A second trace with distinct trace properties so the trace-property
      // filter tests can distinguish filtered vs unfiltered rows.
      const timestamp = new Date().toISOString();
      const res = await apiPost("/api/public/ingestion", {
        batch: [
          {
            id: randomUUID(),
            type: "trace-create",
            timestamp,
            body: {
              id: traceB,
              timestamp,
              name: "v2-trace-b",
              userId: "v2-user-b",
              sessionId: "v2-session-b",
              tags: ["beta-b"],
              environment: "staging",
            },
          },
          {
            id: randomUUID(),
            type: "span-create",
            timestamp,
            body: {
              id: obsB,
              traceId: traceB,
              name: "b-span",
              startTime: "2026-06-01T00:00:00.000Z",
            },
          },
        ],
      });
      expect(res.status).toBe(207);
      expect(res.body.errors).toEqual([]);
    });

    it("filters by sessionId from the traces table (EXISTS subquery)", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "string", column: "sessionId", operator: "=", value: "v2-session-b" },
        ]),
      );
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&filter=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((d: any) => d.id)).toEqual([obsB]);
    });

    it("filters by traceTags (any of) from the traces table", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "stringOptions", column: "traceTags", operator: "any of", value: ["beta-b"] },
        ]),
      );
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&filter=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((d: any) => d.id)).toEqual([obsB]);
    });

    it("filters by traceName from the traces table", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "string", column: "traceName", operator: "=", value: "v2-trace-b" },
        ]),
      );
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&filter=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((d: any) => d.id)).toEqual([obsB]);
    });

    it("rejects unexecutable columns (latency) with 400 instead of returning unfiltered data", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([{ type: "number", column: "latency", operator: ">=", value: 2.5 }]),
      );
      const res = await v2Get<any>(`/api/public/v2/observations?limit=100&filter=${filter}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("latency");
    });

    it("filters with a boolean isRootObservation filter (true)", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "boolean", column: "isRootObservation", operator: "=", value: true },
        ]),
      );
      const res = await v2Get<any>(
        `/api/public/v2/observations?limit=100&traceId=${traceId}&filter=${filter}`,
      );
      expect(res.status).toBe(200);
      expect(new Set(res.body.data.map((d: any) => d.id))).toEqual(new Set(rootObservationIds));
    });

    it("filters with a boolean isRootObservation filter (false)", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "boolean", column: "isRootObservation", operator: "=", value: false },
        ]),
      );
      const res = await v2Get<any>(
        `/api/public/v2/observations?limit=100&traceId=${traceId}&filter=${filter}`,
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: any) => d.id);
      expect(ids).toHaveLength(3);
      expect(ids).not.toContain(root1);
      expect(ids).not.toContain(root2);
    });

    it("filters with a null filter on parentObservationId (is null)", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "null", column: "parentObservationId", operator: "is null", value: "" },
        ]),
      );
      const res = await v2Get<any>(
        `/api/public/v2/observations?limit=100&traceId=${traceId}&filter=${filter}`,
      );
      expect(res.status).toBe(200);
      expect(new Set(res.body.data.map((d: any) => d.id))).toEqual(new Set(rootObservationIds));
    });

    it("filters with a null filter on parentObservationId (is not null)", async () => {
      const filter = encodeURIComponent(
        JSON.stringify([
          { type: "null", column: "parentObservationId", operator: "is not null", value: "" },
        ]),
      );
      const res = await v2Get<any>(
        `/api/public/v2/observations?limit=100&traceId=${traceId}&filter=${filter}`,
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: any) => d.id);
      expect(ids).toHaveLength(3);
      expect(ids).not.toContain(root1);
      expect(ids).not.toContain(root2);
    });

    it("supports simple query parameters (userId / sessionId / type)", async () => {
      const byUser = await v2Get<any>(`/api/public/v2/observations?userId=v2-user&limit=100`);
      expect(byUser.status).toBe(200);
      expect(byUser.body.data).toHaveLength(5);

      const bySession = await v2Get<any>(
        `/api/public/v2/observations?sessionId=v2-session&limit=100`,
      );
      expect(bySession.status).toBe(200);
      expect(bySession.body.data).toHaveLength(5);

      const byType = await v2Get<any>(
        `/api/public/v2/observations?type=GENERATION&limit=100&traceId=${traceId}`,
      );
      expect(byType.status).toBe(200);
      expect(new Set(byType.body.data.map((d: any) => d.id))).toEqual(new Set([root1, root2]));

      const byName = await v2Get<any>(`/api/public/v2/observations?name=child-span&limit=100`);
      expect(byName.status).toBe(200);
      expect(byName.body.data.map((d: any) => d.id)).toEqual([child1]);

      const byEnvironment = await v2Get<any>(
        `/api/public/v2/observations?environment=production&limit=100&traceId=${traceId}`,
      );
      expect(byEnvironment.status).toBe(200);
      expect(byEnvironment.body.data.map((d: any) => d.id)).toEqual([root1]);
    });

    it("filters by the isRootObservation query parameter", async () => {
      const res = await v2Get<any>(
        `/api/public/v2/observations?isRootObservation=true&limit=100&traceId=${traceId}`,
      );
      expect(res.status).toBe(200);
      expect(new Set(res.body.data.map((d: any) => d.id))).toEqual(new Set(rootObservationIds));
    });
  });

  describe("parseIoAsJson", () => {
    it("returns input/output as raw strings by default", async () => {
      const res = await v2Get<any>(`/api/public/v2/observations?fields=io&name=root-gen`);
      expect(res.status).toBe(200);
      const row = res.body.data[0];
      expect(typeof row.input).toBe("string");
      expect(JSON.parse(row.input)).toEqual({ role: "user", content: "hi" });
      expect(typeof row.output).toBe("string");
    });

    it("rejects parseIoAsJson=true with 400 (spec: deprecated, true returns 400)", async () => {
      const res = await v2Get<any>(
        `/api/public/v2/observations?fields=io&parseIoAsJson=true&name=root-gen`,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("parseIoAsJson");
    });

    it("accepts parseIoAsJson=false", async () => {
      const res = await v2Get<any>(
        `/api/public/v2/observations?fields=io&parseIoAsJson=false&name=root-gen`,
      );
      expect(res.status).toBe(200);
      const row = res.body.data[0];
      expect(typeof row.input).toBe("string");
    });
  });
});

afterAll(async () => {
  // This suite seeds traces/observations with fixed (non-"today") timestamps
  // that dashboard's pre-test cleanup cannot see, so remove them here to keep
  // the shared telemetry DB clean regardless of file execution order.
  const { getTelemetryDB } = await import("@peri-fuse/shared/src/server/adapters");
  const telemetry = getTelemetryDB();
  const pattern = `v2-obs-trace-${runId}%`;
  const traceIdCols = {
    observations: "trace_id",
    traces: "id",
    trace_metrics: "trace_id",
  } as const;
  for (const table of ["observations", "traces", "trace_metrics"] as const) {
    await telemetry.command({
      query: `DELETE FROM ${table} WHERE project_id = @projectId AND ${traceIdCols[table]} LIKE @pattern`,
      params: { projectId: TEST_PROJECT_ID, pattern },
    });
  }
});
