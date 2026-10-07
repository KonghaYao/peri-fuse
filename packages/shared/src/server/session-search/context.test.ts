import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase as createLocalDatabase } from "../../db/local";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import { getSessionContext } from "./context";
import { extractMessages } from "./extraction";
import { querySessionSearchRead } from "./read-pool";
import { SessionSearchStorage } from "./storage";

const db = await createLocalDatabase(":memory:");
vi.mock("./read-pool", () => ({
  querySessionSearchRead: vi.fn(
    async (
      adapter: { query: (options: { query: string; params: Record<string, unknown> }) => unknown },
      query: string,
      params: Record<string, unknown>,
    ) => adapter.query({ query, params }),
  ),
}));
vi.mock("../adapters", () => ({
  getTelemetryDB: () => ({
    query: async (o: { query: string; params?: Record<string, unknown> }) =>
      await db.all(o.query, o.params ?? {}),
  }),
}));
const project = "context-project";

beforeAll(async () => {
  await initializeTelemetrySchema(db);
  await db.run(
    "INSERT INTO traces(id,project_id,session_id,timestamp,is_deleted) VALUES(?,?,?,?,0)",
    "trace-1",
    project,
    "session-1",
    "2026-01-01 00:00:00",
  );
  const storage = new SessionSearchStorage(db);
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    content: `message ${i}`,
  }));
  await storage.indexSource(
    {
      projectId: project,
      kind: "trace",
      id: "trace-1",
      revision: 1,
      traceId: "trace-1",
      eventTime: "2026-01-01T00:00:00.000Z",
    },
    extractMessages(messages, undefined),
  );
  await db.run(
    "INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(?,?,?,?)",
    project,
    "trace",
    "trace-1",
    1,
  );
});
afterAll(async () => await db.close());

describe("session context projection", () => {
  it("returns two messages before and after a middle anchor", async () => {
    const row = (await db.get(
      "SELECT occurrence_id,source_version,message_order FROM search_occurrences WHERE project_id=? AND message_order=15 LIMIT 1",
      project,
    )) as { occurrence_id: string; source_version: number; message_order: number };
    vi.mocked(querySessionSearchRead).mockClear();
    const result = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
      before: 2,
      after: 2,
    });
    expect(querySessionSearchRead).toHaveBeenCalledTimes(4);
    expect(result.data.messages.map((m) => m.messageOrder)).toEqual([13, 14, 15, 16, 17]);
    expect(result.meta.afterCursor).toBeTruthy();
  });

  it("rejects a cursor from another project or version", async () => {
    const row = (await db.get(
      "SELECT occurrence_id,source_version FROM search_occurrences WHERE project_id=? LIMIT 1",
      project,
    )) as { occurrence_id: string; source_version: number };
    await expect(
      getSessionContext(project, {
        occurrenceId: row.occurrence_id,
        sourceVersion: row.source_version,
        afterCursor: Buffer.from(
          JSON.stringify({ p: "other", k: "trace", s: "trace-1", v: 1, m: 2, c: 0 }),
        ).toString("base64url"),
      }),
    ).rejects.toThrow("CONTEXT_STALE");
  });

  it("continues with the after cursor", async () => {
    const row = (await db.get(
      "SELECT occurrence_id,source_version FROM search_occurrences WHERE project_id=? AND message_order=15 LIMIT 1",
      project,
    )) as { occurrence_id: string; source_version: number };
    const first = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
      before: 0,
      after: 2,
    });
    expect(first.meta.afterCursor).toBeTruthy();
    const next = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
      afterCursor: first.meta.afterCursor!,
    });
    expect(next.data.messages.every((m) => m.messageOrder >= 18)).toBe(true);
  });

  it("keeps long message chunks separately addressable", async () => {
    const storage = new SessionSearchStorage(db);
    await db.run(
      "INSERT INTO traces(id,project_id,session_id,timestamp,is_deleted) VALUES(?,?,?,?,0)",
      "long-trace",
      project,
      "session-long",
      "2026-01-01 00:00:00",
    );
    await storage.indexSource(
      { projectId: project, kind: "trace", id: "long-trace", revision: 1, traceId: "trace-1" },
      [{ role: "user", field: "input.messages", order: 99, text: `needle ${"x".repeat(25_000)}` }],
    );
    await db.run(
      "INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(?,?,?,?)",
      project,
      "trace",
      "long-trace",
      1,
    );
    const chunks = (await db.all(
      "SELECT chunk_no FROM search_occurrences WHERE source_id=? ORDER BY chunk_no",
      "long-trace",
    )) as Array<{ chunk_no: number }>;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].chunk_no).toBe(chunks[0].chunk_no + 1);
  });

  it("expands chunks as one message and paginates its tail within the wire budget", async () => {
    const row = (await db.get(
      "SELECT occurrence_id,source_version,chunk_no FROM search_occurrences WHERE source_id=? ORDER BY chunk_no LIMIT 1",
      "long-trace",
    )) as { occurrence_id: string; source_version: number; chunk_no: number };
    const first = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
      before: 0,
      after: 0,
    });
    expect(first.data.messages).toHaveLength(1);
    expect(first.data.messages[0].blocks.some((block) => block.chunkNo === row.chunk_no)).toBe(
      true,
    );
    expect(first.data.messages[0].blocks.length).toBeLessThanOrEqual(5);
    expect(first.data.messages[0].blockCursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(32 * 1024);
    const next = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
      blockCursor: first.data.messages[0].blockCursor!,
    });
    expect(next.data.messages[0].blocks[0].chunkNo).toBeGreaterThan(
      first.data.messages[0].blocks.at(-1)!.chunkNo,
    );
  });

  it("keeps a high chunk anchor visible and returns five long neighbors", async () => {
    const storage = new SessionSearchStorage(db);
    await db.run(
      "INSERT INTO traces(id,project_id,session_id,timestamp,is_deleted) VALUES(?,?,?,?,0)",
      "high-anchor",
      project,
      "session-high",
      "2026-01-01 00:00:00",
    );
    const messages = Array.from({ length: 5 }, (_, order) => ({
      role: "user" as const,
      field: "input.messages",
      order,
      text: `${order}-${"邻".repeat(order === 2 ? 500_000 : 20_000)}`,
    }));
    await storage.indexSource(
      { projectId: project, kind: "trace", id: "high-anchor", revision: 1, traceId: "high-anchor" },
      messages,
    );
    await db.run(
      "INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(?,?,?,?)",
      project,
      "trace",
      "high-anchor",
      1,
    );
    const row = (await db.get(
      "SELECT occurrence_id,source_version,chunk_no FROM search_occurrences WHERE source_id=? AND message_order=2 ORDER BY chunk_no DESC LIMIT 1",
      "high-anchor",
    )) as { occurrence_id: string; source_version: number; chunk_no: number };
    expect(row.chunk_no).toBeGreaterThan(100);
    const result = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
    });
    expect(result.data.messages.map((message) => message.messageOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(
      result.data.messages
        .find((message) => message.messageOrder === 2)
        ?.blocks.some((block) => block.chunkNo === row.chunk_no),
    ).toBe(true);
  });

  it("reconstructs multibyte blocks across cursors without overlap", async () => {
    const storage = new SessionSearchStorage(db);
    await db.run(
      "INSERT INTO traces(id,project_id,session_id,timestamp,is_deleted) VALUES(?,?,?,?,0)",
      "multibyte",
      project,
      "session-multi",
      "2026-01-01 00:00:00",
    );
    const source = "你好世界".repeat(8_000);
    await storage.indexSource(
      { projectId: project, kind: "trace", id: "multibyte", revision: 1, traceId: "multibyte" },
      [{ role: "user", field: "input.messages", order: 0, text: source }],
    );
    await db.run(
      "INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(?,?,?,?)",
      project,
      "trace",
      "multibyte",
      1,
    );
    const row = (await db.get(
      "SELECT occurrence_id,source_version FROM search_occurrences WHERE source_id=? LIMIT 1",
      "multibyte",
    )) as { occurrence_id: string; source_version: number };
    let page = await getSessionContext(project, {
      occurrenceId: row.occurrence_id,
      sourceVersion: row.source_version,
    });
    let restored = page.data.messages[0].blocks.map((block) => block.text).join("");
    while (page.data.messages[0].blockCursor) {
      page = await getSessionContext(project, {
        occurrenceId: row.occurrence_id,
        sourceVersion: row.source_version,
        blockCursor: page.data.messages[0].blockCursor!,
      });
      restored += page.data.messages[0].blocks.map((block) => block.text).join("");
    }
    expect(restored).toBe(source);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("uses UTF-16-safe boundaries for mixed emoji and CJK pages", async () => {
    const storage = new SessionSearchStorage(db);
    await db.run(
      "INSERT INTO traces(id,project_id,session_id,timestamp,is_deleted) VALUES(?,?,?,?,0)",
      "mixed-pages",
      project,
      "session-mixed",
      "2026-01-01 00:00:00",
    );
    const source = Array.from({ length: 12_000 }, (_, index) =>
      index % 3 === 0 ? "🙂" : index % 3 === 1 ? "中" : "a",
    ).join("");
    await storage.indexSource(
      { projectId: project, kind: "trace", id: "mixed-pages", revision: 1, traceId: "mixed-pages" },
      [{ role: "user", field: "input.messages", order: 0, text: source }],
    );
    await db.run(
      "INSERT INTO search_source_revisions(project_id,source_kind,source_id,revision) VALUES(?,?,?,?)",
      project,
      "trace",
      "mixed-pages",
      1,
    );
    const chunks = (await db.all(
      "SELECT occurrence_id,source_version,chunk_no,display_start FROM search_occurrences WHERE source_id=? ORDER BY chunk_no",
      "mixed-pages",
    )) as Array<{
      occurrence_id: string;
      source_version: number;
      chunk_no: number;
      display_start: number;
    }>;
    expect(chunks.length).toBeGreaterThan(5);

    let page = await getSessionContext(project, {
      occurrenceId: chunks[0].occurrence_id,
      sourceVersion: chunks[0].source_version,
    });
    let restored = page.data.messages[0].blocks.map((block) => block.text).join("");
    while (page.data.messages[0].blockCursor) {
      page = await getSessionContext(project, {
        occurrenceId: chunks[0].occurrence_id,
        sourceVersion: chunks[0].source_version,
        blockCursor: page.data.messages[0].blockCursor!,
      });
      restored += page.data.messages[0].blocks.map((block) => block.text).join("");
    }
    expect(restored).toBe(source);
    expect(restored).not.toContain("\uFFFD");

    const boundary = chunks[1].display_start;
    const anchor = await getSessionContext(project, {
      occurrenceId: chunks[1].occurrence_id,
      sourceVersion: chunks[1].source_version,
      query: source.slice(boundary - 2, boundary + 4),
      before: 0,
      after: 0,
    });
    const highlighted = anchor.data.messages[0].blocks.flatMap((block) => block.highlight);
    expect(highlighted.length).toBeGreaterThan(0);
    expect(anchor.data.messages[0].blocks.some((block) => block.highlight.length > 0)).toBe(true);
  });

  it("does not expose an indexed occurrence after its source is deleted", async () => {
    const row = (await db.get(
      "SELECT occurrence_id,source_version FROM search_occurrences WHERE source_id=? LIMIT 1",
      "long-trace",
    )) as { occurrence_id: string; source_version: number };
    await db.run("DELETE FROM traces WHERE project_id=? AND id=?", project, "long-trace");
    await expect(
      getSessionContext(project, {
        occurrenceId: row.occurrence_id,
        sourceVersion: row.source_version,
      }),
    ).rejects.toThrow("CONTEXT_UNAVAILABLE");
  });
});
