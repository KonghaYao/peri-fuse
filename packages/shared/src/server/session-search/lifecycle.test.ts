import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openLocalDatabase as createLocalDatabase } from "../../db/local";
import { encodeIoRow, initializeIoSchema } from "../adapters/io-compression";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import { SessionSearchLifecycle } from "./lifecycle";
import { SessionSearchStorage } from "./storage";

describe("session search worker lifecycle", () => {
  it("persists worker tick errors and clears them after recovery", async () => {
    const dbPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "peri-search-error-")),
      "telemetry.db",
    );
    const db = await createLocalDatabase(dbPath);
    await initializeTelemetrySchema(db);
    await initializeIoSchema(db);
    const lifecycle = new SessionSearchLifecycle(db);
    lifecycle.start();
    await db.exec("ALTER TABLE search_dirty RENAME TO search_dirty_broken");
    let failed = false;
    for (let i = 0; i < 30 && !failed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      failed = Boolean(
        (
          (await db.get(
            "SELECT last_error FROM search_index_state WHERE project_id='__global__'",
          )) as { last_error?: string } | undefined
        )?.last_error,
      );
    }
    expect(failed).toBe(true);
    await db.exec("ALTER TABLE search_dirty_broken RENAME TO search_dirty");
    let recovered = false;
    for (let i = 0; i < 30 && !recovered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recovered =
        (
          (await db.get(
            "SELECT last_error FROM search_index_state WHERE project_id='__global__'",
          )) as { last_error?: string } | undefined
        )?.last_error == null;
    }
    expect(recovered).toBe(true);
    await lifecycle.stop();
    await db.close();
  }, 10_000);

  it("consumes dirty sources in a worker and stops cleanly", async () => {
    const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "peri-search-")), "telemetry.db");
    const db = await createLocalDatabase(dbPath);
    await initializeTelemetrySchema(db);
    await initializeIoSchema(db);
    await db.run(
      "INSERT INTO traces(id,project_id,timestamp,input,output) VALUES(?,?,?,?,?)",
      "trace-1",
      "project-1",
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({ messages: [{ role: "user", content: "worker unique phrase" }] }),
      JSON.stringify({ messages: [{ role: "assistant", content: "worker answer" }] }),
    );
    const packed = encodeIoRow(
      "traces",
      {
        input: JSON.stringify({
          messages: [{ role: "user", content: "worker unique phrase 中文 ".repeat(100) }],
        }),
      },
      true,
    );
    expect(packed.input_codec).toBe(1);
    await db.run(
      "UPDATE traces SET input=?, input_codec=?, input_raw_size=? WHERE project_id=? AND id=?",
      packed.input,
      packed.input_codec,
      packed.input_raw_size,
      "project-1",
      "trace-1",
    );
    await new SessionSearchStorage(db).markDirty({
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
        await db.get("SELECT 1 FROM search_texts WHERE instr(normalized_text,'phrase')>0"),
      );
    }
    expect(hit).toBe(true);
    const event = (await db.get("SELECT event_time FROM search_occurrences LIMIT 1")) as {
      event_time: string;
    };
    expect(Date.parse(event.event_time)).toBeLessThan(Date.now() - 60 * 60 * 1000);
    await lifecycle.stop();
    const count = (
      (await db.get("SELECT COUNT(*) as count FROM search_occurrences")) as { count: number }
    ).count;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      ((await db.get("SELECT COUNT(*) as count FROM search_occurrences")) as { count: number })
        .count,
    ).toBe(count);
    await db.close();
  }, 10_000);
});
