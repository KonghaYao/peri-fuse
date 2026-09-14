import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

vi.hoisted(() => {
  process.env.CLICKHOUSE_URL ??= "http://localhost";
  process.env.CLICKHOUSE_USER ??= "x";
  process.env.CLICKHOUSE_PASSWORD ??= "x";
  process.env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET ??= "x";
});

it("keeps telemetry ingestion working when the search DDL is unavailable", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "peri-search-ddl-")), "telemetry.db");
  const db = new Database(file);
  db.exec("CREATE TABLE search_fts(rowid INTEGER, normalized_text TEXT, project_scope TEXT)");
  db.close();
  const adapter = new SQLiteTelemetryAdapter(file);
  await adapter.insert({
    table: "traces",
    records: [{ id: "t1", project_id: "p1", timestamp: "2026-01-01T00:00:00.000Z", input: "{}" }],
  });
  expect(adapter.getDatabase().prepare("SELECT id FROM traces WHERE id='t1'").get()).toBeTruthy();
  expect(adapter.getDatabase().prepare("SELECT COUNT(*) AS n FROM search_dirty").get()).toEqual({
    n: 0,
  });
  adapter.close();
});
