import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import { makeSnippet } from "./highlight";
import { searchSessions } from "./query";
import { querySessionSearchRead, stopSessionSearchReadPool } from "./read-pool";
import { SessionSearchStorage } from "./storage";

vi.hoisted(() => {
  process.env.CLICKHOUSE_URL ??= "http://localhost";
  process.env.CLICKHOUSE_USER ??= "x";
  process.env.CLICKHOUSE_PASSWORD ??= "x";
  process.env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET ??= "x";
});

const db = new Database(":memory:");
const project = "query-project";
vi.mock("../adapters", () => ({
  getTelemetryDB: () => ({
    getDatabase: () => db,
    query: async (o: { query: string; params?: Record<string, unknown> }) =>
      db.prepare(o.query).all(o.params ?? {}),
  }),
}));

function addTrace(
  id: string,
  sessionId: string,
  text: string,
  eventTime: string,
  projectId = project,
  revision = 1,
  userId?: string,
) {
  db.prepare(
    "INSERT INTO traces(id,project_id,session_id,user_id,timestamp,input,output,is_deleted) VALUES(?,?,?,?,?,?,?,0)",
  ).run(
    id,
    projectId,
    sessionId,
    userId ?? null,
    eventTime,
    JSON.stringify({ messages: [{ role: "user", content: text }] }),
    null,
  );
  const storage = new SessionSearchStorage(db);
  storage.markDirty({ projectId, kind: "trace", id, revision, eventTime });
  storage.indexSource({ projectId, kind: "trace", id, revision, traceId: id, eventTime }, [
    { role: "user", field: "input.messages", order: 0, text },
  ]);
}
function addObservation(
  id: string,
  traceId: string,
  text: string,
  eventTime: string,
  projectId = project,
) {
  db.prepare(
    "INSERT INTO observations(id,project_id,trace_id,start_time,input,is_deleted) VALUES(?,?,?,?,?,0)",
  ).run(
    id,
    projectId,
    traceId,
    eventTime,
    JSON.stringify({ messages: [{ role: "user", content: text }] }),
  );
  const storage = new SessionSearchStorage(db);
  storage.markDirty({ projectId, kind: "observation", id, revision: 1, eventTime });
  storage.indexSource({ projectId, kind: "observation", id, revision: 1, traceId, eventTime }, [
    { role: "user", field: "input.messages", order: 0, text },
  ]);
}

beforeEach(() => {
  initializeTelemetrySchema(db);
  db.exec(
    "DELETE FROM search_occurrences; DELETE FROM search_texts; INSERT INTO search_fts(search_fts) VALUES('rebuild'); DELETE FROM search_source_revisions; DELETE FROM search_index_state; DELETE FROM traces;",
  );
});
afterAll(() => db.close());

describe("session search SQLite query", () => {
  it("finds a recent default one-hour record and excludes an old record", async () => {
    addTrace(
      "recent",
      "session-recent",
      "refund failed recently",
      new Date(Date.now() - 5_000).toISOString(),
    );
    addTrace(
      "old",
      "session-old",
      "refund failed old",
      new Date(Date.now() - 7_200_000).toISOString(),
    );
    const result = await searchSessions(project, { query: "failed" });
    expect(result.data.map((x) => x.sessionId)).toEqual(["session-recent"]);
  });

  it("uses a UTC half-open absolute range", async () => {
    addTrace("at", "session-at", "boundary token", "2026-01-01T01:00:00.000Z");
    const result = await searchSessions(project, {
      query: "token",
      timeRange: {
        kind: "absolute",
        fromTimestamp: "2026-01-01T00:00:00Z",
        toTimestamp: "2026-01-01T01:00:00Z",
      },
    });
    expect(result.data).toHaveLength(0);
  });

  it("enforces Unicode code point query limits", async () => {
    await expect(searchSessions(project, { query: "🙂🙂" })).rejects.toThrow("QUERY_TOO_SHORT");
    await expect(searchSessions(project, { query: "🙂".repeat(129) })).rejects.toThrow(
      "QUERY_TOO_LONG",
    );
  });

  it("rejects queries that normalize below the trigram minimum", async () => {
    await expect(searchSessions(project, { query: "e\u0301x" })).rejects.toThrow("QUERY_TOO_SHORT");
  });

  it("rejects an already aborted search before reading", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchSessions(project, { query: "phrase" }, controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("isolates projects sharing the same text", async () => {
    const eventTime = new Date(Date.now() - 10_000).toISOString();
    addTrace("p1", "s1", "same shared phrase", eventTime);
    addTrace("p2", "s2", "same shared phrase", eventTime, "other-project");
    const result = await searchSessions(project, { query: "shared" });
    expect(result.data.map((x) => x.sessionId)).toEqual(["s1"]);
  });

  it("exposes the trace user on the session group", async () => {
    const eventTime = new Date(Date.now() - 10_000).toISOString();
    addTrace("user-trace", "user-session", "user phrase", eventTime, project, 1, "user-1");
    addTrace("parent-user-trace", "parent-user-session", "parent", eventTime, project, 1, "user-2");
    addObservation("user-observation", "parent-user-trace", "observation phrase", eventTime);
    const result = await searchSessions(project, { query: "phrase" });
    expect(result.data.find((group) => group.sessionId === "user-session")?.userId).toBe("user-1");
    expect(result.data.find((group) => group.sessionId === "parent-user-session")?.userId).toBe(
      "user-2",
    );
  });

  it("does not map a trace and observation with the same id across source kinds", async () => {
    const eventTime = new Date(Date.now() - 10_000).toISOString();
    addTrace("same-id", "trace-session", "source collision phrase", eventTime);
    addTrace("parent", "observation-session", "parent", eventTime);
    addObservation("same-id", "parent", "source collision phrase", eventTime);
    expect(
      (await searchSessions(project, { query: "collision" })).data.map((x) => x.sessionId).sort(),
    ).toEqual(["observation-session", "trace-session"]);
  });

  it("rejects stale source revisions and soft-deleted sources", async () => {
    addTrace("versioned", "s-versioned", "version phrase", new Date().toISOString());
    db.prepare(
      "UPDATE search_source_revisions SET revision=2 WHERE project_id=? AND source_id=?",
    ).run(project, "versioned");
    expect((await searchSessions(project, { query: "version" })).data).toHaveLength(0);
    db.prepare(
      "UPDATE search_source_revisions SET revision=1 WHERE project_id=? AND source_id=?",
    ).run(project, "versioned");
    db.prepare("UPDATE traces SET is_deleted=1 WHERE id=?").run("versioned");
    expect((await searchSessions(project, { query: "version" })).data).toHaveLength(0);
  });

  it("deduplicates adjacent chunks from one message", async () => {
    const text = `${"x".repeat(4000)}needle ${"x".repeat(5000)}`;
    addTrace("long", "s-long", text, new Date(Date.now() - 10_000).toISOString());
    const result = await searchSessions(project, { query: "needle" });
    expect(result.data[0]?.hits).toHaveLength(1);
  });

  it("reports index state from persisted state", async () => {
    addTrace("pending", "s-pending", "state phrase", new Date().toISOString());
    db.prepare(
      "UPDATE search_index_state SET pending=2,coverage='backfill' WHERE project_id=?",
    ).run(project);
    const result = await searchSessions(project, { query: "state" });
    expect(result.meta.indexState).toBe("indexing");
    expect(result.meta.coverage).toBe("backfill");
  });

  it("runs a file-backed read through the dedicated worker pool", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "peri-search-read-")), "telemetry.db");
    let fileDb = new Database(file);
    fileDb.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('worker');");
    const adapter = {
      getDatabase: () => fileDb,
      query: async () => {
        throw new Error("sync fallback");
      },
    } as never;
    await expect(querySessionSearchRead(adapter, "SELECT value FROM probe", {})).resolves.toEqual([
      { value: "worker" },
    ]);
    await stopSessionSearchReadPool(adapter);
    fileDb.close();
    fileDb = new Database(file);
    await expect(querySessionSearchRead(adapter, "SELECT value FROM probe", {})).resolves.toEqual([
      { value: "worker" },
    ]);
    await stopSessionSearchReadPool(adapter);
    fileDb.close();
  });

  it("maps NFKC and collapsed whitespace to raw UTF-16 highlight offsets", () => {
    const result = makeSnippet("prefix Ａ   B suffix", "a b");
    expect(result.text).toContain("Ａ   B");
    expect(result.text.slice(result.ranges[0]!.start, result.ranges[0]!.end)).toBe("Ａ   B");
  });

  it("reads the full chunk when the match is beyond the candidate preview", async () => {
    const text = `${"x".repeat(3000)} deep-unique-needle ${"y".repeat(5000)}`;
    addTrace("deep", "s-deep", text, new Date(Date.now() - 10_000).toISOString());
    const result = await searchSessions(project, { query: "unique-needle" });
    expect(result.data[0]?.hits[0]?.snippet).toContain("unique-needle");
    expect(result.data[0]?.hits[0]?.highlight).toHaveLength(1);
  });

  it("searches a wide absolute range with mixed Chinese and ASCII text", async () => {
    addTrace(
      "wide-mixed",
      "s-wide-mixed",
      "请严格执行 Dynamic MCP hap",
      "2026-09-14T06:16:00.000Z",
    );
    const result = await searchSessions(project, {
      query: "请严格执行 Dynamic MCP hap",
      timeRange: {
        kind: "absolute",
        fromTimestamp: "2026-08-01T06:16:00.000Z",
        toTimestamp: "2026-09-28T06:16:00.000Z",
      },
      limit: 20,
    });
    expect(result.data.map((x) => x.sessionId)).toEqual(["s-wide-mixed"]);
  });

  it("keeps wide-range FTS results isolated by project", async () => {
    const eventTime = new Date(Date.now() - 10_000).toISOString();
    addTrace("wide-p1", "wide-s1", "cross project wide phrase", eventTime, project);
    addTrace("wide-p2", "wide-s2", "cross project wide phrase", eventTime, "other-project");
    const result = await searchSessions(project, {
      query: "cross project wide",
      timeRange: {
        kind: "absolute",
        fromTimestamp: "2026-08-01T06:16:00.000Z",
        toTimestamp: "2026-09-28T06:16:00.000Z",
      },
    });
    expect(result.data.map((x) => x.sessionId)).toEqual(["wide-s1"]);
  });

  it.each([86400, 604800] as const)("supports the %s-second relative range", async (seconds) => {
    addTrace(
      `relative-${seconds}`,
      `relative-session-${seconds}`,
      "relative range phrase",
      new Date(Date.now() - 10_000).toISOString(),
    );
    const result = await searchSessions(project, {
      query: "relative range",
      timeRange: { kind: "relative", seconds },
    });
    expect(result.data.map((x) => x.sessionId)).toContain(`relative-session-${seconds}`);
  });
});
