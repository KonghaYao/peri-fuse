import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openLocalDatabase as createLocalDatabase } from "../../db/local";
import { initializeIoSchema } from "../adapters/io-compression";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import { enqueueBackfill } from "./backfill";
import { processDirty } from "./indexer";
import { SessionSearchStorage } from "./storage";

async function open(file: string) {
  const db = await createLocalDatabase(file);
  await initializeTelemetrySchema(db);
  await initializeIoSchema(db);
  return db;
}
describe("bounded persistent session search backfill", () => {
  it("quarantines corrupt source data and resumes when a new revision arrives", async () => {
    const db = await open(
      path.join(mkdtempSync(path.join(os.tmpdir(), "peri-search-retry-")), "telemetry.db"),
    );
    try {
      const storage = new SessionSearchStorage(db);
      const source = { projectId: "p", kind: "trace" as const, id: "damaged", revision: 1 };
      await storage.markDirty(source);
      await storage.markFailed(source, new Error("IO_COMPRESSION_CORRUPT"));
      expect(await storage.listDirty()).toEqual([]);
      expect(await db.get("SELECT * FROM search_dirty")).toBeUndefined();
      expect(
        await db.get(
          "SELECT coverage,pending,last_error FROM search_index_state WHERE project_id='p'",
        ),
      ).toEqual({
        coverage: "limited",
        pending: 0,
        last_error: "permanent: IO_COMPRESSION_CORRUPT",
      });
      await storage.markDirty(source);
      expect((await storage.listDirty()).map((row) => row.id)).toEqual(["damaged"]);
      expect(await db.get("SELECT attempts,last_error FROM search_dirty")).toEqual({
        attempts: 0,
        last_error: null,
      });
    } finally {
      await db.close();
    }
  });

  it("backs off retryable errors and does not overwrite a newer revision", async () => {
    const db = await open(
      path.join(mkdtempSync(path.join(os.tmpdir(), "peri-search-backoff-")), "telemetry.db"),
    );
    try {
      const storage = new SessionSearchStorage(db);
      const source = { projectId: "p", kind: "trace" as const, id: "busy", revision: 1 };
      await storage.markDirty(source);
      await storage.markFailed(source, new Error("database is locked"));
      expect(await storage.listDirty()).toEqual([]);
      expect(await db.get("SELECT attempts,last_error FROM search_dirty")).toEqual({
        attempts: 1,
        last_error: "retryable: database is locked",
      });
      await db.run("UPDATE search_dirty SET attempts=20 WHERE project_id='p' AND source_id='busy'");
      await storage.markFailed(source, new Error("database is locked"));
      const delay = await db.get(
        "SELECT CAST(strftime('%s',next_attempt_at)-strftime('%s','now') AS INTEGER) AS seconds FROM search_dirty WHERE project_id='p' AND source_id='busy'",
      );
      expect((delay as { seconds: number }).seconds).toBeGreaterThanOrEqual(3599);
      expect((delay as { seconds: number }).seconds).toBeLessThanOrEqual(3600);
      await storage.markDirty(source);
      await storage.markFailed(source, new Error("stale failure"));
      expect(await db.get("SELECT attempts,last_error FROM search_dirty")).toEqual({
        attempts: 0,
        last_error: null,
      });
    } finally {
      await db.close();
    }
  });

  it("continues bounded backfill while one source waits for retry", async () => {
    const db = await open(
      path.join(mkdtempSync(path.join(os.tmpdir(), "peri-search-cursor-")), "telemetry.db"),
    );
    try {
      const insert = await db.prepare(
        "INSERT INTO traces(id,project_id,timestamp,input) VALUES(?,?,?,?)",
      );
      for (let index = 0; index < 105; index++) {
        await insert.run(`t-${index}`, "p", "2026-01-01T00:00:00Z", `input-${index}`);
      }
      expect(await enqueueBackfill(db)).toBe(100);
      const storage = new SessionSearchStorage(db);
      const source = (await db.get(
        "SELECT project_id AS projectId,source_kind AS kind,source_id AS id,revision FROM search_dirty WHERE source_id='t-0'",
      )) as { projectId: string; kind: "trace"; id: string; revision: number };
      await storage.markFailed(source, new Error("database is locked"));
      expect(await processDirty(db)).toBe(99);
      expect(await enqueueBackfill(db)).toBe(5);
      expect(await db.get("SELECT attempts FROM search_dirty WHERE source_id='t-0'")).toEqual({
        attempts: 1,
      });
      expect(await processDirty(db)).toBe(5);
      expect(await enqueueBackfill(db)).toBe(0);
      expect(
        await db.get("SELECT coverage FROM search_index_state WHERE project_id='__backfill__'"),
      ).toEqual({
        coverage: "ready",
      });
    } finally {
      await db.close();
    }
  });

  it("maintains O(1) pending counts across duplicate, complete, and limited work", async () => {
    const db = await open(
      path.join(mkdtempSync(path.join(os.tmpdir(), "peri-pending-")), "telemetry.db"),
    );
    const storage = new SessionSearchStorage(db);
    const source = {
      projectId: "pending-project",
      kind: "trace" as const,
      id: "pending-trace",
      revision: 1,
    };
    await storage.markDirty(source);
    await storage.markDirty(source);
    expect(
      (
        (await db.get(
          "SELECT pending FROM search_index_state WHERE project_id=?",
          source.projectId,
        )) as { pending: number }
      ).pending,
    ).toBe(1);
    await processDirty(db, 100);
    expect(
      (
        (await db.get(
          "SELECT pending FROM search_index_state WHERE project_id=?",
          source.projectId,
        )) as { pending: number }
      ).pending,
    ).toBe(0);
    await storage.markDirty({ ...source, id: "too-large" });
    await storage.markLimited({ ...source, id: "too-large" }, "test");
    expect(
      (
        (await db.get(
          "SELECT pending FROM search_index_state WHERE project_id=?",
          source.projectId,
        )) as { pending: number }
      ).pending,
    ).toBe(0);
    await db.close();
  });
  it("limits global passes, resumes after reopen, prioritizes dirty, and reports ready", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peri-backfill-")), "telemetry.db");
    let db = await open(file);
    const insert = await db.prepare(
      "INSERT INTO traces(id,project_id,timestamp,input) VALUES(?,?,?,?)",
    );
    for (let i = 0; i < 250; i++)
      await insert.run(
        `t-${i}`,
        `p-${i % 2}`,
        new Date(Date.now() - 7_200_000).toISOString(),
        JSON.stringify({ messages: [{ role: "user", content: `legacy-${i}` }] }),
      );
    expect(await enqueueBackfill(db)).toBeLessThanOrEqual(100);
    await new SessionSearchStorage(db).markDirty({
      projectId: "p-0",
      kind: "trace",
      id: "t-0",
      revision: 1,
    });
    expect(await enqueueBackfill(db)).toBe(0);
    await processDirty(db, 100);
    await db.close();
    db = await open(file);
    let guard = 0;
    while (guard++ < 10) {
      await enqueueBackfill(db);
      await processDirty(db, 100);
      if (!((await db.get("SELECT COUNT(*) AS n FROM search_dirty")) as { n: number }).n) {
        const state = (await db.get(
          "SELECT coverage FROM search_index_state WHERE project_id='__backfill__'",
        )) as { coverage: string } | undefined;
        if (state?.coverage === "ready") break;
      }
    }
    expect(
      ((await db.get("SELECT COUNT(*) AS n FROM search_occurrences")) as { n: number }).n,
    ).toBe(250);
    expect(
      (
        (await db.get(
          "SELECT coverage FROM search_index_state WHERE project_id='__backfill__'",
        )) as { coverage: string }
      ).coverage,
    ).toBe("ready");
    await db.close();
  });
  it("marks an empty database ready", async () => {
    const db = await open(
      path.join(mkdtempSync(path.join(os.tmpdir(), "peri-empty-")), "telemetry.db"),
    );
    expect(await enqueueBackfill(db)).toBe(0);
    expect(
      (
        (await db.get(
          "SELECT coverage FROM search_index_state WHERE project_id='__backfill__'",
        )) as { coverage: string }
      ).coverage,
    ).toBe("ready");
    const before = (await db.get("SELECT total_changes() AS count")) as { count: number };
    expect(await enqueueBackfill(db)).toBe(0);
    const after = (await db.get("SELECT total_changes() AS count")) as { count: number };
    expect(after.count).toBe(before.count);
    await db.close();
  });
});
