/**
 * v2/v3 scores public API integration tests (T1).
 *
 * Covers:
 * - v3: keyset cursor pagination (incl. same-timestamp rows — no dupes, no
 *   gaps; final page meta.cursor=null), invalid cursor → 400, limit>100 → 400,
 *   field groups (details/subject/annotation), unknown field group → 400,
 *   cross-field 400 validation (value/dataType, valueMin/valueMax,
 *   traceId↔sessionId, observationId-requires-traceId), filters, project
 *   isolation.
 * - v2: page/limit pagination + meta, trace field group (JOIN traces for
 *   userId/tags/environment/sessionId), userId/traceTags filters require the
 *   trace group (else 400), filter JSON metadata stringObject, get-by-id
 *   200/404, unknown field group → 400, project isolation.
 *
 * The v2/v3 routes are not yet wired into app.ts (T6 owns that), so this
 * suite mounts them on a fresh app instance. Static routes match before the
 * `/api/public/*` fallback, so requests reach the handlers.
 */
import { randomUUID } from "node:crypto";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiteServerEnv } from "../auth";
import scoresRoutes from "../routes/scores";
import scoresV2Routes from "../routes/scores-v2";
import scoresV3Routes from "../routes/scores-v3";
import { basicAuth } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";
import { TEST_PROJECT_ID } from "./test-db-paths";

const runId = randomUUID().slice(0, 8);

// ─── test data ───────────────────────────────────────────────────────────────

const TRACE_1 = `tr-${runId}-1`;
const TRACE_2 = `tr-${runId}-2`;
const OBS_1 = `obs-${runId}-1`;
const SESS_1 = `sess-${runId}-1`;

/** scores inserted with distinct timestamps for the main pagination test. */
const DISTINCT_TS_SCORES = [
  {
    id: `sc-${runId}-1`,
    trace_id: TRACE_1,
    name: "accuracy",
    value: 0.9,
    data_type: "NUMERIC",
    string_value: null,
    environment: "prod",
    timestamp: "2026-01-01 00:00:00.000",
    comment: "good",
    config_id: "cfg-1",
  },
  {
    id: `sc-${runId}-2`,
    trace_id: TRACE_1,
    name: "accuracy",
    value: 0.8,
    data_type: "NUMERIC",
    string_value: null,
    environment: "prod",
    timestamp: "2026-01-01 00:00:00.500",
  },
  {
    id: `sc-${runId}-3`,
    trace_id: TRACE_2,
    name: "fluency",
    value: 1,
    data_type: "BOOLEAN",
    string_value: "True",
    environment: "dev",
    timestamp: "2026-01-01 01:00:00.000",
    author_user_id: "ann-1",
    queue_id: "q-1",
  },
  {
    id: `sc-${runId}-4`,
    trace_id: TRACE_1,
    observation_id: OBS_1,
    name: "feedback",
    value: 0,
    data_type: "CATEGORICAL",
    string_value: "cat-a",
    environment: "prod",
    timestamp: "2026-01-01 02:00:00.000",
  },
  {
    id: `sc-${runId}-5`,
    trace_id: TRACE_2,
    name: "txt",
    value: 0,
    data_type: "TEXT",
    string_value: "hello world",
    environment: "dev",
    timestamp: "2026-01-01 03:00:00.000",
  },
  {
    id: `sc-${runId}-6`,
    trace_id: TRACE_1,
    name: "accuracy",
    value: 0.5,
    data_type: "NUMERIC",
    string_value: null,
    environment: "prod",
    session_id: SESS_1,
    timestamp: "2026-01-01 00:00:00.000",
    metadata: { user_id: "meta-user" },
  },
];

/** scores sharing one timestamp (keyset stability across equal keys). */
function sameTimestampScores(ts: string, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `same-${runId}-${i}`,
    trace_id: TRACE_1,
    name: "same-ts",
    value: i,
    data_type: "NUMERIC",
    string_value: null,
    environment: "prod",
    timestamp: ts,
  }));
}

async function seed(): Promise<void> {
  const db = getTelemetryDB();

  await db.insert({
    table: "traces",
    records: [
      {
        id: TRACE_1,
        project_id: TEST_PROJECT_ID,
        timestamp: "2026-01-01 00:00:00.000",
        name: "trace-1",
        user_id: "user-1",
        tags: JSON.stringify(["t1", "t2"]),
        environment: "prod",
        session_id: "sess-trace",
        created_at: "2026-01-01 00:00:00.000",
        updated_at: "2026-01-01 00:00:00.000",
        event_ts: "2026-01-01 00:00:00.000",
        is_deleted: 0,
      },
      {
        id: TRACE_2,
        project_id: TEST_PROJECT_ID,
        timestamp: "2026-01-01 00:00:00.000",
        name: "trace-2",
        user_id: "user-2",
        tags: JSON.stringify(["t2"]),
        environment: "dev",
        session_id: null,
        created_at: "2026-01-01 00:00:00.000",
        updated_at: "2026-01-01 00:00:00.000",
        event_ts: "2026-01-01 00:00:00.000",
        is_deleted: 0,
      },
    ],
  });

  const now = "2026-01-01 00:00:00.000";
  const base = {
    project_id: TEST_PROJECT_ID,
    source: "API",
    comment: null,
    author_user_id: null,
    config_id: null,
    queue_id: null,
    observation_id: null,
    session_id: null,
    metadata: null,
    created_at: now,
    updated_at: now,
    event_ts: now,
    is_deleted: 0,
  };
  const rows = DISTINCT_TS_SCORES.map((s) => ({
    ...base,
    ...s,
    metadata: s.metadata ? JSON.stringify(s.metadata) : null,
  }));

  await db.insert({ table: "scores", records: rows });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

let mountedApp: Hono<LiteServerEnv> | null = null;

/**
 * App with the v2/v3 routes mounted (app.ts wiring is T6's job).
 *
 * NOTE: createApp() cannot be used as a base here — its `/api/public/*` 404
 * fallback is registered as middleware and would be prepended to any route
 * mounted after createApp() returns (SmartRouter resolves all routes at first
 * request), swallowing every request with a 404. So this suite builds a bare
 * app with the same error mapping as app.ts and mounts the routes directly.
 */
function getMountedApp(): Hono<LiteServerEnv> {
  if (!mountedApp) {
    const app = new Hono<LiteServerEnv>();
    app.onError((err, c) => {
      if (err instanceof LangfuseNotFoundError) {
        return c.json({ message: err.message }, 404);
      }
      if (err instanceof BaseError) {
        return c.json({ error: err.name, message: err.message }, err.httpCode as 500);
      }
      return c.json({ message: "Internal Server Error" }, 500);
    });
    app.route("/", scoresV2Routes);
    app.route("/", scoresV3Routes);
    app.route("/", scoresRoutes);
    mountedApp = app;
  }
  return mountedApp;
}

async function v3Get<T = any>(
  path: string,
  auth: string = basicAuth(),
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = auth;
  const res = await getMountedApp().request(path, { headers });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

const v2Get = v3Get;

/** POST to a mounted route (scoresRoutes is mounted too, for session scores). */
async function v3Post<T = any>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await getMountedApp().request(path, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("v3 scores public API", () => {
  beforeAll(async () => {
    await seed();
  });

  it("paginates with keyset cursor across distinct timestamps", async () => {
    const collected: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const url = `/api/public/v3/scores?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await v3Get(url);
      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(2);
      for (const item of res.body.data) collected.push(item.id);
      cursor = res.body.meta.cursor;
      pages++;
    } while (cursor);

    expect(pages).toBeGreaterThan(2);
    // The shared test DB may contain scores inserted by other suites
    // (dashboard/metrics), so assert keyset completeness on the seeded rows:
    // every seed score appears exactly once across the pages, no gaps/dupes.
    const expected = [...DISTINCT_TS_SCORES.map((s) => s.id)].sort();
    for (const id of expected) {
      expect(collected).toContain(id);
    }
    expect(new Set(collected).size).toBe(collected.length);
    // final page has no cursor
    expect(cursor).toBeNull();
  });

  it("orders by timestamp DESC then id DESC", async () => {
    const res = await v3Get(`/api/public/v3/scores?limit=10&name=accuracy`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: any) => s.id);
    // sc-2 (00:00:00.500) first, then the 00:00:00.000 pair id DESC (sc-6 > sc-1)
    expect(ids).toEqual([`sc-${runId}-2`, `sc-${runId}-6`, `sc-${runId}-1`]);
  });

  it("filters by name / dataType / environment / configId", async () => {
    const res = await v3Get(`/api/public/v3/scores?cursor=${encodeURIComponent("not-base64url")}`);
    expect(res.status).toBe(400);

    const badPayload = Buffer.from(JSON.stringify({ v: 99, lastTimestamp: "x" })).toString(
      "base64url",
    );
    const res2 = await v3Get(`/api/public/v3/scores?cursor=${encodeURIComponent(badPayload)}`);
    expect(res2.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const res = await v3Get(`/api/public/v3/scores?limit=101`);
    expect(res.status).toBe(400);
  });

  it("rejects unknown field groups with 400", async () => {
    const res = await v3Get(`/api/public/v3/scores?fields=details,bogus`);
    expect(res.status).toBe(400);
  });

  it("returns details group (comment/configId/metadata) when requested", async () => {
    const res = await v3Get(
      `/api/public/v3/scores?fields=details&id=${`sc-${runId}-1`},${`sc-${runId}-6`}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const byId = new Map(res.body.data.map((s: any) => [s.id, s]));
    const s1 = byId.get(`sc-${runId}-1`);
    expect(s1.comment).toBe("good");
    expect(s1.configId).toBe("cfg-1");
    expect(s1.metadata).toEqual({});
    const s6 = byId.get(`sc-${runId}-6`);
    expect(s6.metadata).toEqual({ user_id: "meta-user" });
    expect(s6.comment).toBeNull();
  });

  it("returns subject group with kind + id", async () => {
    // trace-level score
    const trace = await v3Get(`/api/public/v3/scores?fields=subject&id=${`sc-${runId}-1`}`);
    expect(trace.body.data[0].subject).toEqual({ kind: "trace", id: TRACE_1 });

    // observation-level score carries traceId
    const obs = await v3Get(`/api/public/v3/scores?fields=subject&id=${`sc-${runId}-4`}`);
    expect(obs.body.data[0].subject).toEqual({ kind: "observation", id: OBS_1, traceId: TRACE_1 });

    // session-level score (session_id set, no observation) → kind session
    const sess = await v3Get(`/api/public/v3/scores?fields=subject&id=${`sc-${runId}-6`}`);
    expect(sess.body.data[0].subject).toEqual({ kind: "session", id: SESS_1 });
  });

  it("returns annotation group (authorUserId/queueId) when requested", async () => {
    const res = await v3Get(`/api/public/v3/scores?fields=annotation&id=${`sc-${runId}-3`}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].authorUserId).toBe("ann-1");
    expect(res.body.data[0].queueId).toBe("q-1");
  });

  it("omits optional groups when fields is not requested", async () => {
    const res = await v3Get(`/api/public/v3/scores?limit=1`);
    expect(res.status).toBe(200);
    const s = res.body.data[0];
    expect(s.comment).toBeUndefined();
    expect(s.authorUserId).toBeUndefined();
    expect(s.subject).toBeUndefined();
  });

  it("filters by name / dataType / environment / configId", async () => {
    const byName = await v3Get(`/api/public/v3/scores?name=accuracy`);
    expect(byName.status).toBe(200);
    expect(byName.body.data.map((s: any) => s.id).sort()).toEqual(
      [`sc-${runId}-1`, `sc-${runId}-2`, `sc-${runId}-6`].sort(),
    );

    const byType = await v3Get(`/api/public/v3/scores?dataType=numeric`); // case-insensitive
    expect(byType.status).toBe(200);
    expect(byType.body.data.every((s: any) => s.dataType === "NUMERIC")).toBe(true);

    const byEnv = await v3Get(`/api/public/v3/scores?environment=dev`);
    expect(byEnv.status).toBe(200);
    expect(byEnv.body.data.map((s: any) => s.environment)).toEqual(["dev", "dev"]);

    const byConfig = await v3Get(`/api/public/v3/scores?configId=cfg-1`);
    expect(byConfig.status).toBe(200);
    expect(byConfig.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-1`]);
  });

  it("filters by comma-separated id list", async () => {
    const res = await v3Get(`/api/public/v3/scores?id=${`sc-${runId}-1`},${`sc-${runId}-3`}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.id).sort()).toEqual(
      [`sc-${runId}-1`, `sc-${runId}-3`].sort(),
    );
  });

  it("filters by time range (fromTimestamp inclusive, toTimestamp exclusive)", async () => {
    const res = await v3Get(
      `/api/public/v3/scores?fromTimestamp=${encodeURIComponent("2026-01-01T01:00:00.000Z")}&toTimestamp=${encodeURIComponent("2026-01-01T03:00:00.000Z")}`,
    );
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: any) => s.id).sort();
    // 01:00 and 02:00 included; 03:00 excluded
    expect(ids).toEqual([`sc-${runId}-3`, `sc-${runId}-4`].sort());
  });

  it("filters by traceId / sessionId / observationId", async () => {
    const byTrace = await v3Get(`/api/public/v3/scores?traceId=${TRACE_2}`);
    expect(byTrace.body.data.every((s: any) => s.subject === undefined)).toBe(true); // no subject group
    expect(byTrace.body.data.map((s: any) => s.id).sort()).toEqual(
      [`sc-${runId}-3`, `sc-${runId}-5`].sort(),
    );

    const bySession = await v3Get(`/api/public/v3/scores?sessionId=${SESS_1}`);
    expect(bySession.status).toBe(200);
    expect(bySession.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-6`]);

    const byObs = await v3Get(`/api/public/v3/scores?traceId=${TRACE_1}&observationId=${OBS_1}`);
    expect(byObs.status).toBe(200);
    expect(byObs.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-4`]);
  });

  it("validates value filter combinations", async () => {
    // value without dataType → 400
    const noDt = await v3Get(`/api/public/v3/scores?value=0.9`);
    expect(noDt.status).toBe(400);

    // value with multiple dataTypes → 400
    const multiDt = await v3Get(`/api/public/v3/scores?value=0.9&dataType=NUMERIC,BOOLEAN`);
    expect(multiDt.status).toBe(400);

    // value with TEXT dataType → 400
    const textDt = await v3Get(`/api/public/v3/scores?value=x&dataType=TEXT`);
    expect(textDt.status).toBe(400);

    // NUMERIC exact match
    const numeric = await v3Get(`/api/public/v3/scores?value=0.9&dataType=NUMERIC`);
    expect(numeric.status).toBe(200);
    expect(numeric.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-1`]);

    // BOOLEAN values must be true/false
    const badBool = await v3Get(`/api/public/v3/scores?value=1&dataType=BOOLEAN`);
    expect(badBool.status).toBe(400);
    const goodBool = await v3Get(`/api/public/v3/scores?value=true&dataType=BOOLEAN`);
    expect(goodBool.status).toBe(200);
    expect(goodBool.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-3`]);

    // CATEGORICAL matches string_value
    const cat = await v3Get(`/api/public/v3/scores?value=cat-a&dataType=CATEGORICAL`);
    expect(cat.status).toBe(200);
    expect(cat.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-4`]);
  });

  it("validates valueMin/valueMax require NUMERIC", async () => {
    const bad = await v3Get(`/api/public/v3/scores?valueMin=0.5&dataType=BOOLEAN`);
    expect(bad.status).toBe(400);
    const noDt = await v3Get(`/api/public/v3/scores?valueMax=0.5`);
    expect(noDt.status).toBe(400);

    const ok = await v3Get(
      `/api/public/v3/scores?name=accuracy&valueMin=0.8&valueMax=0.9&dataType=NUMERIC`,
    );
    expect(ok.status).toBe(200);
    // sc-1 (0.9) and sc-2 (0.8) fall inside [0.8, 0.9]; sc-6 (0.5) does not.
    // `name=accuracy` isolates the seed rows from other suites' scores.
    expect(ok.body.data.map((s: any) => s.id).sort()).toEqual(
      [`sc-${runId}-1`, `sc-${runId}-2`].sort(),
    );
  });

  it("enforces traceId/sessionId mutual exclusion", async () => {
    const res = await v3Get(`/api/public/v3/scores?traceId=${TRACE_1}&sessionId=${SESS_1}`);
    expect(res.status).toBe(400);
  });

  it("requires traceId for observationId", async () => {
    const res = await v3Get(`/api/public/v3/scores?observationId=${OBS_1}`);
    expect(res.status).toBe(400);
  });

  it("scopes results to the project", async () => {
    const second: SecondProject = await createSecondProject();
    await getTelemetryDB().insert({
      table: "scores",
      records: [
        {
          id: `sc-${runId}-other`,
          project_id: second.projectId,
          trace_id: "other-trace",
          name: "other",
          value: 1,
          data_type: "NUMERIC",
          string_value: null,
          source: "API",
          environment: "prod",
          comment: null,
          author_user_id: null,
          config_id: null,
          queue_id: null,
          observation_id: null,
          session_id: null,
          metadata: null,
          timestamp: "2026-01-01 05:00:00.000",
          created_at: "2026-01-01 05:00:00.000",
          updated_at: "2026-01-01 05:00:00.000",
          event_ts: "2026-01-01 05:00:00.000",
          is_deleted: 0,
        },
      ],
    });

    const res = await v3Get(`/api/public/v3/scores?name=other`, second.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-other`]);

    // The primary project must not see the second project's score.
    const own = await v3Get(`/api/public/v3/scores?name=other`);
    expect(own.body.data).toEqual([]);
  });

  it("rejects unknown query parameters with 400", async () => {
    const res = await v3Get(`/api/public/v3/scores?bogusParam=1`);
    expect(res.status).toBe(400);
  });

  it("rejects non-empty userId / traceTags with 400 (v3 has no trace JOIN)", async () => {
    const byUser = await v3Get(`/api/public/v3/scores?userId=user-1`);
    expect(byUser.status).toBe(400);
    expect(byUser.body.message).toContain("userId");

    const byTags = await v3Get(`/api/public/v3/scores?traceTags=t1`);
    expect(byTags.status).toBe(400);
    expect(byTags.body.message).toContain("traceTags");

    // Empty-string values are normalized to undefined (templating systems) —
    // they must NOT trigger the 400.
    const empty = await v3Get(`/api/public/v3/scores?userId=&traceTags=&limit=1`);
    expect(empty.status).toBe(200);
  });

  it("persists a session score (sessionId without traceId) and lists it via v3", async () => {
    const id = `sc-${runId}-sess-post`;
    const sessionId = `sess-post-${runId}`;
    const post = await v3Post("/api/public/scores", {
      id,
      sessionId,
      name: "session-score",
      value: 0.7,
      dataType: "NUMERIC",
    });
    expect(post.status).toBe(200);
    expect(post.body.id).toBe(id);

    const bySession = await v3Get(`/api/public/v3/scores?fields=subject&sessionId=${sessionId}`);
    expect(bySession.status).toBe(200);
    const row = bySession.body.data.find((s: any) => s.id === id);
    expect(row).toBeDefined();
    expect(row.value).toBe(0.7);
    expect(row.subject).toEqual({ kind: "session", id: sessionId });
  });

  it("persists a CORRECTION score and reads the corrected text back via v3", async () => {
    const id = `sc-${runId}-corr`;
    const text = "corrected output text";
    const post = await v3Post("/api/public/scores", {
      id,
      traceId: TRACE_1,
      name: "correction",
      value: text,
      dataType: "CORRECTION",
    });
    expect(post.status).toBe(200);
    expect(post.body.id).toBe(id);

    const res = await v3Get(`/api/public/v3/scores?id=${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].dataType).toBe("CORRECTION");
    expect(res.body.data[0].value).toBe(text);
  });

  it("pagination over same-timestamp rows is stable (no dupes, no gaps)", async () => {
    const ts = "2026-02-01 10:00:00.000";
    const rows = sameTimestampScores(ts, 5);
    await getTelemetryDB().insert({
      table: "scores",
      records: rows.map((r) => ({
        ...r,
        project_id: TEST_PROJECT_ID,
        source: "API",
        comment: null,
        author_user_id: null,
        config_id: null,
        queue_id: null,
        observation_id: null,
        session_id: null,
        metadata: null,
        created_at: ts,
        updated_at: ts,
        event_ts: ts,
        is_deleted: 0,
      })),
    });

    const collected: string[] = [];
    let cursor: string | null | undefined;
    do {
      // limit=3 (not 2): the earlier pagination test used limit=2, and the
      // responseCache (TTL 2s) would serve its stale results for the same URL.
      // `name=same-ts` isolates these rows from other suites' scores.
      const url = `/api/public/v3/scores?name=same-ts&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await v3Get(url);
      expect(res.status).toBe(200);
      for (const item of res.body.data) collected.push(item.id);
      cursor = res.body.meta.cursor;
    } while (cursor);

    const expected = rows.map((r) => r.id).sort();
    // Every same-timestamp row is collected exactly once, no gaps, no dupes.
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.sort()).toEqual(expected);
  });
});

describe("v2 scores public API", () => {
  beforeAll(async () => {
    await seed();
  });

  it("lists scores with page/limit and meta", async () => {
    const res = await v2Get(`/api/public/v2/scores?page=1&limit=3`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(3);
    expect(res.body.meta.totalItems).toBeGreaterThanOrEqual(6);
    expect(res.body.meta.totalPages).toBe(Math.ceil(res.body.meta.totalItems / 3));
  });

  it("joins the traces table for the trace field group", async () => {
    const res = await v2Get(`/api/public/v2/scores?traceId=${TRACE_1}&limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const withTrace = res.body.data.find((s: any) => s.trace !== undefined);
    expect(withTrace).toBeDefined();
    expect(withTrace.trace.userId).toBe("user-1");
    expect(withTrace.trace.tags).toEqual(["t1", "t2"]);
    expect(withTrace.trace.environment).toBe("prod");
    expect(withTrace.trace.sessionId).toBe("sess-trace");
  });

  it("omits the trace object when fields=score only", async () => {
    const res = await v2Get(`/api/public/v2/scores?fields=score&limit=3`);
    expect(res.status).toBe(200);
    for (const s of res.body.data) {
      expect(s.trace).toBeUndefined();
    }
  });

  it("requires the trace field group when filtering by userId", async () => {
    const bad = await v2Get(`/api/public/v2/scores?userId=user-1&fields=score`);
    expect(bad.status).toBe(400);

    const ok = await v2Get(`/api/public/v2/scores?userId=user-1`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.length).toBeGreaterThan(0);
    for (const s of ok.body.data) {
      expect(s.trace.userId).toBe("user-1");
    }
  });

  it("requires the trace field group when filtering by traceTags", async () => {
    const bad = await v2Get(`/api/public/v2/scores?traceTags=t1&fields=score`);
    expect(bad.status).toBe(400);

    const ok = await v2Get(`/api/public/v2/scores?traceTags=t1,t2`);
    expect(ok.status).toBe(200);
    // only scores linked to traces that include ALL of these tags → TRACE_1 only
    // (TRACE_1 carries tags ["t1","t2"]; TRACE_2 only ["t2"]). The v2 response
    // exposes the score's own traceId (BaseScore field) — every row must belong
    // to TRACE_1, and the seed rows of TRACE_1 must all be present. The
    // same-timestamp rows inserted by the v3 pagination test also live on
    // TRACE_1, so the result may contain more than the seed rows.
    const ids = ok.body.data.map((s: any) => s.id).sort();
    const trace1Seeds = DISTINCT_TS_SCORES.filter((s) => s.trace_id === TRACE_1).map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(trace1Seeds.length);
    for (const id of trace1Seeds) {
      expect(ids).toContain(id);
    }
    for (const s of ok.body.data) {
      expect(s.traceId).toBe(TRACE_1);
      expect(s.trace.userId).toBe("user-1");
    }
  });

  it("filters by environment and sessionId", async () => {
    const byEnv = await v2Get(`/api/public/v2/scores?environment=dev`);
    expect(byEnv.status).toBe(200);
    expect(byEnv.body.data.map((s: any) => s.environment)).toEqual(["dev", "dev"]);

    const bySession = await v2Get(`/api/public/v2/scores?sessionId=${SESS_1}`);
    expect(bySession.status).toBe(200);
    expect(bySession.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-6`]);
  });

  it("supports filter JSON with stringObject metadata keys", async () => {
    const filter = JSON.stringify([
      {
        type: "stringObject",
        column: "metadata",
        key: "user_id",
        operator: "=",
        value: "meta-user",
      },
    ]);
    const res = await v2Get(`/api/public/v2/scores?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-6`]);
  });

  it("applies filter JSON on traces-table columns (userId / trace_tags / traceName)", async () => {
    // userId → EXISTS subquery on traces.user_id → TRACE_2 (user-2) only.
    const byUser = await v2Get(
      `/api/public/v2/scores?filter=${encodeURIComponent(
        JSON.stringify([{ type: "string", column: "userId", operator: "=", value: "user-2" }]),
      )}`,
    );
    expect(byUser.status).toBe(200);
    const userIds = byUser.body.data.map((s: any) => s.id).sort();
    expect(userIds).toEqual([`sc-${runId}-3`, `sc-${runId}-5`].sort());

    // trace_tags (all of) → only scores on traces containing ALL tags:
    // TRACE_1 has ["t1","t2"], TRACE_2 has ["t2"] → TRACE_1 scores only.
    const byTags = await v2Get(
      `/api/public/v2/scores?filter=${encodeURIComponent(
        JSON.stringify([
          { type: "arrayOptions", column: "trace_tags", operator: "all of", value: ["t1"] },
        ]),
      )}`,
    );
    expect(byTags.status).toBe(200);
    const tagIds = byTags.body.data.map((s: any) => s.id);
    const trace1Seeds = DISTINCT_TS_SCORES.filter((s) => s.trace_id === TRACE_1).map((s) => s.id);
    expect(tagIds.length).toBeGreaterThanOrEqual(trace1Seeds.length);
    for (const id of trace1Seeds) {
      expect(tagIds).toContain(id);
    }
    for (const s of byTags.body.data) {
      expect(s.traceId).toBe(TRACE_1);
    }

    // traceName → EXISTS subquery on traces.name.
    const byName = await v2Get(
      `/api/public/v2/scores?filter=${encodeURIComponent(
        JSON.stringify([{ type: "string", column: "traceName", operator: "=", value: "trace-2" }]),
      )}`,
    );
    expect(byName.status).toBe(200);
    const nameIds = byName.body.data.map((s: any) => s.id).sort();
    expect(nameIds).toEqual([`sc-${runId}-3`, `sc-${runId}-5`].sort());
  });

  it("rejects unexecutable filter JSON columns (booleanValue) with 400", async () => {
    const res = await v2Get(
      `/api/public/v2/scores?filter=${encodeURIComponent(
        JSON.stringify([{ type: "boolean", column: "booleanValue", operator: "=", value: true }]),
      )}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("not supported");
  });

  it("does not double-apply environment to the traces subquery", async () => {
    // Score on TRACE_2 (trace.environment = dev) with its own environment =
    // prod. environment + userId must filter scores.environment only; the
    // traces subquery (userId) must not also require trace.environment.
    const id = `sc-${runId}-envmix`;
    const ts = "2026-01-01 04:00:00.000";
    await getTelemetryDB().insert({
      table: "scores",
      records: [
        {
          id,
          project_id: TEST_PROJECT_ID,
          trace_id: TRACE_2,
          name: "env-mix",
          value: 1,
          data_type: "NUMERIC",
          string_value: null,
          source: "API",
          environment: "prod",
          comment: null,
          author_user_id: null,
          config_id: null,
          queue_id: null,
          observation_id: null,
          session_id: null,
          metadata: null,
          timestamp: ts,
          created_at: ts,
          updated_at: ts,
          event_ts: ts,
          is_deleted: 0,
        },
      ],
    });

    const res = await v2Get(`/api/public/v2/scores?environment=prod&userId=user-2&limit=50`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: any) => s.id);
    expect(ids).toContain(id);
  });

  it("rejects unknown field groups with 400", async () => {
    const res = await v2Get(`/api/public/v2/scores?fields=score,bogus`);
    expect(res.status).toBe(400);
  });

  it("gets a single score by id", async () => {
    const res = await v2Get(`/api/public/v2/scores/${`sc-${runId}-1`}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(`sc-${runId}-1`);
    expect(res.body.name).toBe("accuracy");
    expect(res.body.value).toBe(0.9);
    expect(res.body.dataType).toBe("NUMERIC");
    expect(res.body.traceId).toBe(TRACE_1);

    const missing = await v2Get(`/api/public/v2/scores/${`missing-${runId}`}`);
    expect(missing.status).toBe(404);
  });

  it("scopes results to the project", async () => {
    const second: SecondProject = await createSecondProject();
    await getTelemetryDB().insert({
      table: "scores",
      records: [
        {
          id: `sc-${runId}-other`,
          project_id: second.projectId,
          trace_id: "other-trace",
          name: "other",
          value: 1,
          data_type: "NUMERIC",
          string_value: null,
          source: "API",
          environment: "prod",
          comment: null,
          author_user_id: null,
          config_id: null,
          queue_id: null,
          observation_id: null,
          session_id: null,
          metadata: null,
          timestamp: "2026-01-01 05:00:00.000",
          created_at: "2026-01-01 05:00:00.000",
          updated_at: "2026-01-01 05:00:00.000",
          event_ts: "2026-01-01 05:00:00.000",
          is_deleted: 0,
        },
      ],
    });

    const res = await v2Get(`/api/public/v2/scores?name=other`, second.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.id)).toEqual([`sc-${runId}-other`]);
  });

  afterAll(async () => {
    // This suite seeds traces/scores under this run's unique id prefix.
    // Remove them so suites asserting all-time counts (dashboard) never see
    // them regardless of file execution order. id-LIKE scoping keeps other
    // suites' rows (incl. observations-v2's 2026-01-01 data) untouched.
    const telemetry = getTelemetryDB();
    const patterns = [
      ["traces", `tr-${runId}-%`],
      ["scores", `sc-${runId}-%`],
      ["scores", `same-${runId}-%`],
    ] as const;
    for (const [table, pattern] of patterns) {
      await telemetry.command({
        query: `DELETE FROM ${table} WHERE id LIKE @pattern`,
        params: { pattern },
      });
    }
  });
});
