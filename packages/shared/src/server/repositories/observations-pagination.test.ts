import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import type { TelemetryQueryOpts } from "../adapters/types";
import { FilterList, StringFilter } from "../queries/clickhouse-sql/clickhouse-filter";
import { liteGetObservationsTable, liteGetObservationsTableCount } from "./lite-queries";

const { query } = vi.hoisted(() => {
  process.env.LANGFUSE_MODE = "lite";
  return { query: vi.fn() };
});
vi.mock("../adapters", () => ({ getTelemetryDB: () => ({ query }) }));

const db = new Database(":memory:");
const plans: string[][] = [];
const filter = new FilterList(
  [
    ["type", "GENERATION"],
    ["level", "ERROR"],
  ].map(
    ([field, value]) =>
      new StringFilter({ clickhouseTable: "observations", field, operator: "=", value }),
  ),
);

beforeAll(() => {
  initializeTelemetrySchema(db);
  const insert = db.prepare(`
    INSERT INTO observations
      (project_id, id, type, level, start_time, is_deleted, input)
    VALUES (@projectId, @id, @type, @level, @startTime, @deleted, @input)
  `);
  const input = JSON.stringify({ prompt: "x".repeat(4096) });
  db.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      const row = {
        projectId: "pagination-project",
        id: `observation-${i}`,
        type: i % 2 === 0 ? "GENERATION" : "SPAN",
        level: i % 100 < 2 ? "ERROR" : "DEFAULT",
        startTime: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        deleted: 0,
        input,
      };
      insert.run(row);
      if (i % 100 === 0) {
        insert.run({ ...row, projectId: "other-project" });
        insert.run({ ...row, id: `deleted-${i}`, deleted: 1 });
      }
    }
  })();
  db.exec("ANALYZE");
  query.mockImplementation(async ({ query: sql, params }: TelemetryQueryOpts) => {
    const bindings = params ?? {};
    plans.push(
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(bindings)
        .map((row) => (row as { detail: string }).detail),
    );
    return db.prepare(sql).all(bindings);
  });
});

afterAll(() => db.close());

describe("filtered observations pagination", () => {
  it("counts type + level matches without visiting observation payloads", async () => {
    const started = performance.now();
    expect(await liteGetObservationsTableCount("pagination-project", filter)).toBe(100);
    const plan = plans.at(-1)!.join("\n");
    console.info(`observations count: ${(performance.now() - started).toFixed(2)}ms; ${plan}`);
    expect(plan).toContain("USING COVERING INDEX");
    expect(plan).toContain("type=?");
    expect(plan).toContain("level=?");
  });

  it("seeks the second filtered page in order and preserves project/deletion scopes", async () => {
    const started = performance.now();
    const rows = await liteGetObservationsTable("pagination-project", 25, 1, filter);
    const plan = plans.at(-1)!.join("\n");
    console.info(`observations page: ${(performance.now() - started).toFixed(2)}ms; ${plan}`);
    expect(rows.map((row) => row.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `observation-${7400 - i * 100}`),
    );
    expect(rows[0].input).toBe(JSON.stringify({ prompt: "x".repeat(4096) }));
    expect(plan).toContain("type=?");
    expect(plan).toContain("level=?");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(await liteGetObservationsTable("pagination-project", 25, 4, filter)).toEqual([]);
  });

  it("adds the index to an existing database idempotently without changing observations", async () => {
    db.exec("DROP INDEX idx_obs_type_level_start");
    initializeTelemetrySchema(db);
    initializeTelemetrySchema(db);
    db.exec("ANALYZE");
    expect(await liteGetObservationsTableCount("pagination-project", filter)).toBe(100);
    expect(plans.at(-1)!.join("\n")).toContain("USING COVERING INDEX");
    expect(await liteGetObservationsTableCount("other-project", filter)).toBe(100);
  });
});
