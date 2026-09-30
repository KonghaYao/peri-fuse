import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

type SessionResult = {
  data: Array<{ id: string; countTraces: number }>;
  meta: { totalItems: number; totalPages: number };
};

const sessionId = `filter-session-${randomUUID()}`;
const tag = `literal_%-"${randomUUID()}`;
let auth: string;
let otherAuth: string;

describe("session list filters", () => {
  beforeAll(async () => {
    auth = (await createSecondProject()).auth;
    otherAuth = (await createSecondProject()).auth;
    const timestamp = new Date().toISOString();
    for (const projectAuth of [auth, otherAuth]) {
      const res = await apiPost(
        "/api/public/ingestion",
        {
          batch: [
            {
              id: randomUUID(),
              type: "trace-create",
              timestamp,
              body: { id: randomUUID(), sessionId, tags: [tag], timestamp },
            },
            {
              id: randomUUID(),
              type: "trace-create",
              timestamp,
              body: {
                id: randomUUID(),
                sessionId: `${sessionId}-other`,
                tags: ["unrelated"],
                timestamp,
              },
            },
          ],
        },
        {},
        projectAuth,
      );
      expect(res.status).toBe(207);
      expect(res.body.errors).toEqual([]);
    }
  });

  it("matches a session ID exactly before pagination", async () => {
    const res = await apiGet<SessionResult>(
      `/api/public/sessions?sessionId=${sessionId}&limit=1`,
      auth,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((row) => row.id)).toEqual([sessionId]);
    expect(res.body.data[0].countTraces).toBe(1);
    expect(res.body.meta).toMatchObject({ totalItems: 1, totalPages: 1 });
    const next = await apiGet<SessionResult>(
      `/api/public/sessions?sessionId=${sessionId}&limit=1&page=2`,
      auth,
    );
    expect(next.body.data).toEqual([]);
    expect(next.body.meta.totalItems).toBe(1);
  });

  it("matches literal tag values including SQL wildcards and JSON quotes", async () => {
    const res = await apiGet<SessionResult>(
      `/api/public/sessions?tags=${encodeURIComponent(tag)}`,
      auth,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((row) => row.id)).toEqual([sessionId]);
    expect(res.body.meta.totalItems).toBe(1);
    const partial = await apiGet<SessionResult>("/api/public/sessions?tags=literal", auth);
    expect(partial.body.data).toEqual([]);
  });

  it("combines filters with AND semantics", async () => {
    const res = await apiGet<SessionResult>(
      `/api/public/sessions?sessionId=${sessionId}-other&tags=${encodeURIComponent(tag)}`,
      auth,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.totalItems).toBe(0);
  });

  it("keeps identical session IDs and tags isolated across projects", async () => {
    for (const projectAuth of [auth, otherAuth]) {
      const res = await apiGet<SessionResult>(
        `/api/public/sessions?sessionId=${sessionId}&tags=${encodeURIComponent(tag)}`,
        projectAuth,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].countTraces).toBe(1);
      expect(res.body.meta.totalItems).toBe(1);
    }
  });
});
