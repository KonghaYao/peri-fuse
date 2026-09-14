import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import { SessionSearchLifecycle } from "./lifecycle";
import { SessionSearchStorage } from "./storage";

describe("session search worker lifecycle", () => {
  it("persists worker tick errors and clears them after recovery", async () => {
    const dbPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "peri-search-error-")),
      "telemetry.db",
    );
    const db = new Database(dbPath);
    initializeTelemetrySchema(db);
    const lifecycle = new SessionSearchLifecycle(db);
    lifecycle.start();
    db.exec("ALTER TABLE search_dirty RENAME TO search_dirty_broken");
    let failed = false;
    for (let i = 0; i < 30 && !failed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      failed = Boolean(
        (
          db
            .prepare("SELECT last_error FROM search_index_state WHERE project_id='__global__'")
            .get() as { last_error?: string } | undefined
        )?.last_error,
      );
    }
    expect(failed).toBe(true);
    db.exec("ALTER TABLE search_dirty_broken RENAME TO search_dirty");
    let recovered = false;
    for (let i = 0; i < 30 && !recovered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recovered =
        (
          db
            .prepare("SELECT last_error FROM search_index_state WHERE project_id='__global__'")
            .get() as { last_error?: string } | undefined
        )?.last_error == null;
    }
    expect(recovered).toBe(true);
    await lifecycle.stop();
    db.close();
  }, 10_000);

  it("consumes dirty sources in a worker and stops cleanly", async () => {
    const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "peri-search-")), "telemetry.db");
    const db = new Database(dbPath);
    initializeTelemetrySchema(db);
    db.prepare("INSERT INTO traces(id,project_id,timestamp,input,output) VALUES(?,?,?,?,?)").run(
      "trace-1",
      "project-1",
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({ messages: [{ role: "user", content: "worker unique phrase" }] }),
      JSON.stringify({ messages: [{ role: "assistant", content: "worker answer" }] }),
    );
    new SessionSearchStorage(db).markDirty({
      projectId: "project-1",
      kind: "trace",
      id: "trace-1",
      revision: 1,
    });
    const lifecycle = new SessionSearchLifecycle(db);
    lifecycle.start();
    let hit = false;
    for (let i = 0; i < 30 && !hit; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      hit = Boolean(
        db.prepare("SELECT 1 FROM search_fts WHERE normalized_text MATCH 'phrase'").get(),
      );
    }
    expect(hit).toBe(true);
    const event = db.prepare("SELECT event_time FROM search_occurrences LIMIT 1").get() as {
      event_time: string;
    };
    expect(Date.parse(event.event_time)).toBeLessThan(Date.now() - 60 * 60 * 1000);
    await lifecycle.stop();
    const count = (
      db.prepare("SELECT COUNT(*) as count FROM search_occurrences").get() as { count: number }
    ).count;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      (db.prepare("SELECT COUNT(*) as count FROM search_occurrences").get() as { count: number })
        .count,
    ).toBe(count);
    db.close();
  }, 10_000);
});
