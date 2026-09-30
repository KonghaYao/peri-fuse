import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeIoSchema, installIoReader } from "../adapters/io-compression";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import type { TelemetryQueryOpts } from "../adapters/types";
import { liteGetTracesTable, liteGetTracesTableCount } from "./lite-trace-queries";

const db = new Database(":memory:");
vi.mock("../adapters", () => ({
  getTelemetryDB: () => ({
    query: async ({ query, params }: TelemetryQueryOpts) => db.prepare(query).all(params ?? {}),
  }),
}));

beforeAll(() => {
  initializeTelemetrySchema(db);
  initializeIoSchema(db);
  installIoReader(db);
  const insert = db.prepare(`INSERT INTO traces
    (project_id,id,name,timestamp,is_deleted) VALUES (?,?,?,?,?)`);
  for (const projectId of ["project-a", "project-b"]) {
    for (let i = 1; i <= 4; i++) {
      insert.run(projectId, `trace-${i}`, `match-${i}`, `2026-01-0${i} 00:00:00.000`, 0);
    }
    insert.run(projectId, "deleted", "match-deleted", "2026-01-05 00:00:00.000", 1);
    insert.run(projectId, "outside", "different", "2026-01-06 00:00:00.000", 0);
  }
});
afterAll(() => db.close());

// The Lite table uses SQLite pagination; the upstream ClickHouse deletion-cursor
// service was never shipped in this repository.
describe("trace table SQLite pagination", () => {
  it("keeps pages and counts project-scoped while excluding deleted and unmatched traces", async () => {
    const options = { projectId: "project-a", searchQuery: "match", limit: 2 };
    const first = await liteGetTracesTable({ ...options, page: 0 });
    const second = await liteGetTracesTable({ ...options, page: 1 });
    expect(first.map((row) => row.id)).toEqual(["trace-4", "trace-3"]);
    expect(second.map((row) => row.id)).toEqual(["trace-2", "trace-1"]);
    expect([...first, ...second].every((row) => row.projectId === "project-a")).toBe(true);
    expect(await liteGetTracesTableCount("project-a", "match")).toBe(4);
    expect(await liteGetTracesTable({ ...options, page: 2 })).toEqual([]);
  });

  it("supports ascending order and an empty project independently", async () => {
    const rows = await liteGetTracesTable({
      projectId: "project-b",
      searchQuery: "match",
      limit: 2,
      orderBy: { column: "timestamp", order: "ASC" },
    });
    expect(rows.map((row) => row.id)).toEqual(["trace-1", "trace-2"]);
    expect(rows.every((row) => row.projectId === "project-b")).toBe(true);
    expect(await liteGetTracesTable({ projectId: "empty" })).toEqual([]);
    expect(await liteGetTracesTableCount("empty")).toBe(0);
  });
});
