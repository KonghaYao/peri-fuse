import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

type ErrorResult = {
  summary: { totalErrors: number; affectedTraces: number };
  data: { id: string; traceId: string }[];
  groups: { count: number }[];
  models: { count: number }[];
  daily: { count: number }[];
  meta: { cursor: string | null };
};

const prefix = randomUUID();
const traceId = `trace-${prefix}`;
const userId = `user-${prefix}`;
const sessionId = `session-${prefix}`;
const signature = `failure-${prefix}`;

function batch(id: string, user: string, session: string, count: number) {
  const timestamp = new Date().toISOString();
  return [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp,
      body: { id, timestamp, userId: user, sessionId: session },
    },
    ...Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      type: "generation-create",
      timestamp,
      body: {
        id: randomUUID(),
        traceId: id,
        startTime: timestamp,
        name: `call-${index}`,
        level: "ERROR",
        statusMessage: signature,
        model: "filter-model",
      },
    })),
  ];
}

describe("error identity filters", () => {
  beforeAll(async () => {
    expect(
      (
        await apiPost("/api/public/ingestion", {
          batch: [
            ...batch(traceId, userId, sessionId, 2),
            ...batch(`other-${prefix}`, `other-user-${prefix}`, `other-session-${prefix}`, 1),
          ],
        })
      ).status,
    ).toBe(207);
    const second = await createSecondProject();
    expect(
      (
        await apiPost(
          "/api/public/ingestion",
          {
            batch: batch(traceId, `foreign-user-${prefix}`, `foreign-session-${prefix}`, 1),
          },
          {},
          second.auth,
        )
      ).status,
    ).toBe(207);
  });

  it.each(["traceId", "userId", "sessionId"])(
    "filters all aggregates and pages by %s",
    async (key) => {
      const values: Record<string, string> = { traceId, userId, sessionId };
      const params = new URLSearchParams({ search: signature, [key]: values[key], limit: "1" });
      const first = await apiGet<ErrorResult>(`/api/public/errors?${params}`);
      expect(first.status).toBe(200);
      expect(first.body.summary).toMatchObject({ totalErrors: 2, affectedTraces: 1 });
      expect(first.body.groups[0].count).toBe(2);
      expect(first.body.models[0].count).toBe(2);
      expect(first.body.daily.reduce((total, day) => total + day.count, 0)).toBe(2);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.data[0].traceId).toBe(traceId);
      expect(first.body.meta.cursor).toEqual(expect.any(String));
      params.set("cursor", first.body.meta.cursor ?? "");
      const next = await apiGet<ErrorResult>(`/api/public/errors?${params}`);
      expect(next.body.summary.totalErrors).toBe(2);
      expect(next.body.data).toHaveLength(1);
      expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
      expect(next.body.meta.cursor).toBeNull();
    },
  );

  it("combines identity filters and uses exact IDs", async () => {
    for (const filters of [
      { userId, sessionId: `other-session-${prefix}` },
      { userId: prefix },
      { sessionId: prefix },
      { traceId: prefix },
    ]) {
      const result = await apiGet<ErrorResult>(
        `/api/public/errors?${new URLSearchParams({
          search: signature,
          ...filters,
        })}`,
      );
      expect(result.body.summary.totalErrors).toBe(0);
      expect(result.body.data).toEqual([]);
    }
  });

  it("matches a trace only when all supplied identities match", async () => {
    const result = await apiGet<ErrorResult>(
      `/api/public/errors?${new URLSearchParams({
        search: signature,
        traceId,
        userId,
        sessionId,
      })}`,
    );
    expect(result.status).toBe(200);
    expect(result.body.summary.totalErrors).toBe(2);
    expect(result.body.data.every((error) => error.traceId === traceId)).toBe(true);
  });

  it("does not resolve user/session from another project's trace with the same ID", async () => {
    for (const filters of [
      { userId: `foreign-user-${prefix}` },
      { sessionId: `foreign-session-${prefix}` },
    ]) {
      const result = await apiGet<ErrorResult>(
        `/api/public/errors?${new URLSearchParams({
          search: signature,
          ...filters,
        })}`,
      );
      expect(result.body.summary.totalErrors).toBe(0);
    }
  });

  it.each(["traceId", "userId", "sessionId"])("validates %s length", async (key) => {
    expect((await apiGet(`/api/public/errors?${key}=${"x".repeat(201)}`)).status).toBe(400);
  });
});
