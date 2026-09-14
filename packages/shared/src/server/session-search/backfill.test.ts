import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import { enqueueBackfill } from "./backfill";
import { processDirty } from "./indexer";
import { SessionSearchStorage } from "./storage";

function open(file: string) {
  const db = new Database(file);
  initializeTelemetrySchema(db);
  return db;
}
describe("bounded persistent session search backfill", () => {
  it("maintains O(1) pending counts across duplicate, complete, and limited work", () => {
    const db = open(
      path.join(mkdtempSync(path.join(os.tmpdir(), "peri-pending-")), "telemetry.db"),
    );
    const storage = new SessionSearchStorage(db);
    const source = {
      projectId: "pending-project",
      kind: "trace" as const,
      id: "pending-trace",
      revision: 1,
    };
    storage.markDirty(source);
    storage.markDirty(source);
    expect(
      (
        db
          .prepare("SELECT pending FROM search_index_state WHERE project_id=?")
          .get(source.projectId) as { pending: number }
      ).pending,
    ).toBe(1);
    processDirty(db, 100);
    expect(
      (
        db
          .prepare("SELECT pending FROM search_index_state WHERE project_id=?")
          .get(source.projectId) as { pending: number }
      ).pending,
    ).toBe(0);
    storage.markDirty({ ...source, id: "too-large" });
    storage.markLimited({ ...source, id: "too-large" }, "test");
    expect(
      (
        db
          .prepare("SELECT pending FROM search_index_state WHERE project_id=?")
          .get(source.projectId) as { pending: number }
      ).pending,
    ).toBe(0);
    db.close();
  });
  it("limits global passes, resumes after reopen, prioritizes dirty, and reports ready", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peri-backfill-")), "telemetry.db");
    let db = open(file);
    const insert = db.prepare("INSERT INTO traces(id,project_id,timestamp,input) VALUES(?,?,?,?)");
    for (let i = 0; i < 250; i++)
      insert.run(
        `t-${i}`,
        `p-${i % 2}`,
        new Date(Date.now() - 7_200_000).toISOString(),
        JSON.stringify({ messages: [{ role: "user", content: `legacy-${i}` }] }),
      );
    expect(enqueueBackfill(db)).toBeLessThanOrEqual(100);
    new SessionSearchStorage(db).markDirty({
      projectId: "p-0",
      kind: "trace",
      id: "t-0",
      revision: 1,
    });
    expect(enqueueBackfill(db)).toBe(0);
    processDirty(db, 100);
    db.close();
    db = open(file);
    let guard = 0;
    while (guard++ < 10) {
      enqueueBackfill(db);
      processDirty(db, 100);
      if (!(db.prepare("SELECT COUNT(*) AS n FROM search_dirty").get() as { n: number }).n) {
        const state = db
          .prepare("SELECT coverage FROM search_index_state WHERE project_id='__backfill__'")
          .get() as { coverage: string } | undefined;
        if (state?.coverage === "ready") break;
      }
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM search_occurrences").get() as { n: number }).n,
    ).toBe(250);
    expect(
      (
        db
          .prepare("SELECT coverage FROM search_index_state WHERE project_id='__backfill__'")
          .get() as { coverage: string }
      ).coverage,
    ).toBe("ready");
    db.close();
  });
  it("marks an empty database ready", () => {
    const db = open(path.join(mkdtempSync(path.join(os.tmpdir(), "peri-empty-")), "telemetry.db"));
    expect(enqueueBackfill(db)).toBe(0);
    expect(
      (
        db
          .prepare("SELECT coverage FROM search_index_state WHERE project_id='__backfill__'")
          .get() as { coverage: string }
      ).coverage,
    ).toBe("ready");
    db.close();
  });
});
