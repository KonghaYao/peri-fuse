import { randomUUID } from "node:crypto";
import { getTelemetryDB, SQLiteTelemetryAdapter } from "@peri-fuse/shared/src/server/adapters";
import {
  type SessionSearchLifecycle,
  startSessionSearch,
} from "@peri-fuse/shared/src/server/session-search/lifecycle";
import type {
  ContextResponse,
  SessionSearchResponse,
} from "@peri-fuse/shared/src/server/session-search/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

const traceId = `search-trace-${randomUUID()}`;
const generationId = `search-generation-${randomUUID()}`;
const sessionId = `search-session-${randomUUID()}`;
const now = Date.now();
const from = new Date(now - 60_000).toISOString();
const to = new Date(now + 60_000).toISOString();
let lifecycle: SessionSearchLifecycle;

type IngestionResponse = { errors: unknown[]; successes: unknown[] };

async function search(query: string, extra: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await apiPost<SessionSearchResponse>("/api/public/session-search", {
      query,
      timeRange: { kind: "absolute", fromTimestamp: from, toTimestamp: to },
      ...extra,
    });
    if (result.status === 200 && result.body.data?.length) return result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return apiPost<SessionSearchResponse>("/api/public/session-search", {
    query,
    timeRange: { kind: "absolute", fromTimestamp: from, toTimestamp: to },
    ...extra,
  });
}

describe("session search API ingestion roundtrip", () => {
  beforeAll(async () => {
    const adapter = getTelemetryDB();
    if (!(adapter instanceof SQLiteTelemetryAdapter)) throw new Error("Expected SQLite adapter");
    lifecycle = startSessionSearch(adapter.getDatabase());
    const result = await apiPost<IngestionResponse>("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: new Date(now).toISOString(),
          body: {
            id: traceId,
            timestamp: new Date(now).toISOString(),
            sessionId,
            input: {
              messages: [
                { role: "system", content: "system needle must stay hidden" },
                { role: "user", content: "user roundtrip needle alpha" },
                { role: "tool", content: "tool secret needle must stay hidden" },
                { role: "assistant", content: "assistant roundtrip needle beta" },
              ],
            },
            output: {
              messages: [
                { role: "tool", content: "tool output needle must stay hidden" },
                { role: "assistant", content: "final assistant roundtrip needle" },
              ],
            },
          },
        },
        {
          id: randomUUID(),
          type: "generation-create",
          timestamp: new Date(now).toISOString(),
          body: {
            id: generationId,
            traceId,
            name: "search generation",
            startTime: new Date(now).toISOString(),
            input: {
              messages: [
                { role: "user", content: "generation user roundtrip needle" },
                { role: "system", content: "generation system needle hidden" },
                { role: "tool", content: "generation tool needle hidden" },
              ],
            },
            output: {
              messages: [
                { role: "assistant", content: "generation assistant roundtrip needle" },
                { role: "tool", content: "generation tool result needle hidden" },
              ],
            },
          },
        },
      ],
    });
    expect(result.status).toBe(207);
    expect(result.body.errors).toEqual([]);
    expect(result.body.successes).toHaveLength(2);
  });

  afterAll(async () => lifecycle?.stop());

  it("projects ingestion through the worker and returns bounded hits", async () => {
    const result = await search("roundtrip needle");
    expect(result.status).toBe(200);
    expect(result.body.data.length).toBeGreaterThan(0);
    expect(result.body.data.every((row) => row.sessionId === sessionId)).toBe(true);
    const hits = result.body.data[0].hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.snippet.length > 0)).toBe(true);
    expect(hits.every((hit) => ["user", "assistant"].includes(hit.role))).toBe(true);
    expect(result.body.meta.resolvedTimeRange.fromTimestamp).toBe(from);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(64 * 1024);
  });

  it("uses the documented one hour range by default", async () => {
    const result = await apiPost<SessionSearchResponse>("/api/public/session-search", {
      query: "roundtrip needle",
    });
    expect(result.status).toBe(200);
    expect(result.body.data.length).toBeGreaterThan(0);
    const range = result.body.meta.resolvedTimeRange;
    expect(Date.parse(range.toTimestamp) - Date.parse(range.fromTimestamp)).toBe(3_600_000);
  });

  it("excludes tool and system text and provides source context", async () => {
    const hidden = await search("tool secret");
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toEqual([]);
    const found = await search("user roundtrip");
    const hit = found.body.data[0]?.hits?.[0];
    expect(hit).toBeDefined();
    const context = await apiPost<ContextResponse>("/api/public/session-search/context", {
      occurrenceId: hit.occurrenceId,
      sourceVersion: hit.sourceVersion,
      before: 1,
      after: 1,
      query: "roundtrip",
    });
    expect(context.status).toBe(200);
    expect(context.body.data.messages.length).toBeGreaterThan(0);
    expect(
      context.body.data.messages.every((message) => ["user", "assistant"].includes(message.role)),
    ).toBe(true);
    expect(
      context.body.data.messages.every((message) => !message.text.includes("tool secret")),
    ).toBe(true);
  });

  it("enforces auth, validates body, and isolates projects", async () => {
    expect(
      (
        await apiPost<Record<string, unknown>>(
          "/api/public/session-search",
          { query: "needle" },
          {},
          "",
        )
      ).status,
    ).toBe(401);
    expect(
      (await apiPost<Record<string, unknown>>("/api/public/session-search", { query: "x" })).status,
    ).toBe(400);
    const other = await createSecondProject();
    const isolated = await apiPost<SessionSearchResponse>(
      "/api/public/session-search",
      { query: "roundtrip needle" },
      {},
      other.auth,
    );
    expect(isolated.status).toBe(200);
    expect(isolated.body.data).toEqual([]);
  });

  it("reindexes updates and removes deleted sources", async () => {
    const replacement = `replacement-${randomUUID()}`;
    const update = await apiPost<IngestionResponse>("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: new Date(now).toISOString(),
          body: {
            id: traceId,
            timestamp: new Date(now).toISOString(),
            sessionId,
            input: { messages: [{ role: "user", content: replacement }] },
            output: { messages: [{ role: "assistant", content: "updated assistant" }] },
          },
        },
      ],
    });
    expect(update.status).toBe(207);
    const updated = await search(replacement);
    expect(updated.body.data.length).toBeGreaterThan(0);
    const old = await search("roundtrip needle alpha");
    expect(old.body.data).toEqual([]);
    await getTelemetryDB().command({
      query: "DELETE FROM traces WHERE project_id=@projectId AND id=@traceId",
      params: { projectId: "test-project-lite-server", traceId },
    });
    const deleted = await search(replacement);
    expect(deleted.body.data).toEqual([]);
  });
});
