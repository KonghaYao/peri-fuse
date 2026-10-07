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
    await db.close();
  });
});
