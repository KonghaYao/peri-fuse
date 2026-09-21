import { dirname, join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "../adapters/sqlite-telemetry-adapter";
import type { AuthHeaderValidVerificationResultIngestion } from "../auth/types";

vi.mock("../adapters", () => ({ getTelemetryDB: () => active }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { processEventBatchLite } from "../ingestion/processEventBatchLite";
import { loadMaterializedDays, recomputeDay } from "./daily-stats";
import { purgeOlderThan } from "./retention";

const base = process.env.LANGFUSE_SQLITE_DB_PATH;
if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
process.env.PERIFUSE_IO_COMPRESSION_WRITE = "on";
const path = join(dirname(base), "review-reliability.db");
const db = new SQLiteTelemetryAdapter(path);
const peer = new SQLiteTelemetryAdapter(path);
let active = db;
const sql = db.getDatabase();
const auth = {
  validKey: true,
  scope: { projectId: "p", accessLevel: "project" },
} as AuthHeaderValidVerificationResultIngestion;
const event = (
  id: string,
  body: Record<string, unknown>,
  type = "trace-create",
  timestamp = "2026-01-01T00:00:00Z",
) => ({ id, body, type, timestamp });
const run = (events: unknown[]) => processEventBatchLite(events, auth, {});
const patch = (adapter: SQLiteTelemetryAdapter, model: string) =>
  adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        start_time: "2020-01-01 00:00:00.000",
        type: "GENERATION",
        model,
        usage_details: JSON.stringify({ total: model === "old" ? 1 : 2 }),
      },
    ],
    updateColumns: [["model", "usage_details"]],
  });

beforeEach(() => {
  active = db;
  sql.exec(
    "DELETE FROM telemetry_retention_state; DELETE FROM observations; DELETE FROM traces; DELETE FROM scores; DELETE FROM ingestion_field_versions; DELETE FROM daily_stats_dirty; DELETE FROM daily_stats; DELETE FROM daily_model_stats;",
  );
});
afterAll(async () => {
  await db.close();
  await peer.close();
});

it.each(["", "null", '""'])("迟到继承不能覆盖显式正文 %j 或其版本，重试保持一致", async (input) => {
  const newer = event("new", { id: "t", input }, "trace-create", "2026-03-01T00:00:00Z");
  expect((await run([newer])).errors).toEqual([]);
  const before = sql
    .prepare("SELECT versions FROM ingestion_field_versions WHERE entity_type='traces'")
    .get();
  await run([
    event("old", { id: "t" }),
    event(
      "obs",
      { id: "o", traceId: "t", input: "old inherited".repeat(200) },
      "generation-create",
    ),
  ]);
  expect(sql.prepare("SELECT input,input_codec FROM traces").get()).toEqual({
    input,
    input_codec: 0,
  });
  expect(
    sql.prepare("SELECT versions FROM ingestion_field_versions WHERE entity_type='traces'").get(),
  ).toEqual(before);
  await run([newer]);
  expect(sql.prepare("SELECT input FROM perifuse_read_traces").get()).toEqual({ input });
});

it("从未提供的正文可迟到继承，正文/codec/版本同事务并阻挡更旧显式值", async () => {
  await run([event("new", { id: "t" }, "trace-create", "2026-03-01T00:00:00Z")]);
  const input = "inherited 中文".repeat(200);
  const batch = [
    event("old", { id: "t" }),
    event("obs", { id: "o", traceId: "t", input }, "generation-create"),
  ];
  sql.exec(
    "CREATE TRIGGER fail_inherit BEFORE UPDATE ON traces BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  try {
    expect((await run(batch)).errors).toHaveLength(1);
  } finally {
    sql.exec("DROP TRIGGER fail_inherit");
  }
  expect(sql.prepare("SELECT input FROM traces").get()).toEqual({ input: null });
  expect((await run(batch)).errors).toEqual([]);
  expect(sql.prepare("SELECT input FROM perifuse_read_traces").get()).toEqual({ input });
  expect(sql.prepare("SELECT input_codec FROM traces").get()).toEqual({ input_codec: 1 });
  const row = sql
    .prepare("SELECT versions FROM ingestion_field_versions WHERE entity_type='traces'")
    .get() as { versions: string };
  expect(JSON.parse(row.versions).input).toEqual(["2026-01-01 00:00:00.000", "old"]);
  await run([event("older", { id: "t", input: "stale" }, "trace-create", "2025-01-01T00:00:00Z")]);
  expect(sql.prepare("SELECT input FROM perifuse_read_traces").get()).toEqual({ input });
});

it("两个独立汇总发布者交错时，旧快照不能覆盖已确认的新汇总", async () => {
  await patch(db, "old");
  let release!: () => void;
  let paused!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const publish = db.commandBatch.bind(db);
  const spy = vi.spyOn(db, "commandBatch").mockImplementationOnce(async (...args) => {
    paused();
    await gate;
    return publish(...args);
  });
  const old = recomputeDay("p", "2020-01-01");
  await reached;
  try {
    await patch(peer, "new");
    active = peer;
    vi.resetModules();
    const independent = await import("./daily-stats");
    await independent.recomputeDay("p", "2020-01-01");
  } finally {
    release();
    await old;
    spy.mockRestore();
    active = db;
  }
  expect(sql.prepare("SELECT tokens FROM daily_stats").get()).toEqual({ tokens: 2 });
  expect(sql.prepare("SELECT model FROM daily_model_stats").all()).toEqual([{ model: "new" }]);
  expect(sql.prepare("SELECT dirty FROM daily_stats_dirty").get()).toEqual({ dirty: 0 });
});

it("发布失败同时回滚两个汇总表和 dirty 确认", async () => {
  await patch(db, "old");
  await recomputeDay("p", "2020-01-01");
  await patch(db, "new");
  sql.exec(
    "CREATE TRIGGER fail_publish BEFORE INSERT ON daily_model_stats BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  try {
    await expect(recomputeDay("p", "2020-01-01")).rejects.toThrow();
  } finally {
    sql.exec("DROP TRIGGER fail_publish");
  }
  expect(sql.prepare("SELECT tokens FROM daily_stats").get()).toEqual({ tokens: 1 });
  expect(sql.prepare("SELECT model FROM daily_model_stats").get()).toEqual({ model: "old" });
  expect(sql.prepare("SELECT dirty FROM daily_stats_dirty").get()).toEqual({ dirty: 1 });
  await loadMaterializedDays("p", null, null);
  expect(sql.prepare("SELECT model FROM daily_model_stats").get()).toEqual({ model: "new" });
});

it("retention 清理版本及 dirty，不复活过期桶，保留截止日和其他项目实体版本", async () => {
  for (const project_id of ["p", "q"]) {
    await db.insert({
      table: "traces",
      records: [
        {
          project_id,
          id: "same",
          timestamp: project_id === "p" ? "2020-01-01 00:00:00.000" : "2026-01-02 13:00:00.000",
          input: "keep",
          event_ts: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      updateColumns: [["timestamp", "input"]],
      eventIds: ["a"],
    });
  }
  await patch(db, "old");
  await recomputeDay("p", "2020-01-01");
  let release!: () => void;
  let paused!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const publish = db.commandBatch.bind(db);
  const spy = vi.spyOn(db, "commandBatch").mockImplementationOnce(async (...args) => {
    paused();
    await gate;
    return publish(...args);
  });
  const stale = recomputeDay("p", "2020-01-01");
  await reached;
  try {
    await purgeOlderThan("2026-01-02 12:00:00.000");
  } finally {
    release();
    await stale;
    spy.mockRestore();
  }
  await loadMaterializedDays("p", null, null);
  await recomputeDay("p", "2020-01-01");
  expect(sql.prepare("SELECT * FROM daily_stats WHERE day='2020-01-01'").all()).toEqual([]);
  expect(sql.prepare("SELECT * FROM daily_stats_dirty WHERE day='2020-01-01'").all()).toEqual([]);
  expect(sql.prepare("SELECT project_id,entity_id FROM ingestion_field_versions").all()).toEqual([
    { project_id: "q", entity_id: "same" },
  ]);
  await loadMaterializedDays("q", null, null);
  expect(sql.prepare("SELECT traces FROM daily_stats WHERE project_id='q'").get()).toEqual({
    traces: 1,
  });
});

it("源数据在发布前变化时拒绝旧快照，保留 dirty 供读取重试", async () => {
  await patch(db, "old");
  const publish = db.commandBatch.bind(db);
  const spy = vi.spyOn(db, "commandBatch").mockImplementationOnce(async (...args) => {
    await patch(peer, "new");
    return publish(...args);
  });
  try {
    await recomputeDay("p", "2020-01-01");
    expect(sql.prepare("SELECT * FROM daily_stats").all()).toEqual([]);
    expect(sql.prepare("SELECT dirty FROM daily_stats_dirty").get()).toEqual({ dirty: 1 });
    await loadMaterializedDays("p", null, null);
    expect(sql.prepare("SELECT tokens FROM daily_stats").get()).toEqual({ tokens: 2 });
    expect(sql.prepare("SELECT dirty FROM daily_stats_dirty").get()).toEqual({ dirty: 0 });
  } finally {
    spy.mockRestore();
  }
});

it("删除触发器覆盖全部实体，retention 同时清除旧版遗留孤儿版本", async () => {
  for (const table of ["traces", "observations", "scores"]) {
    const time = table === "observations" ? "start_time" : "timestamp";
    const extra = table === "scores" ? { name: "score", data_type: "NUMERIC" } : {};
    await db.insert({
      table,
      records: [{ project_id: "p", id: "deleted", [time]: "2020-01-01", ...extra }],
    });
    sql
      .prepare("INSERT INTO ingestion_field_versions VALUES(?,?,?,?)")
      .run("p", table, "deleted", "{}");
    sql
      .prepare("INSERT INTO ingestion_field_versions VALUES(?,?,?,?)")
      .run("p", table, "orphan", "{}");
  }
  await purgeOlderThan("2026-01-01 00:00:00.000");
  expect(sql.prepare("SELECT * FROM ingestion_field_versions").all()).toEqual([]);
  expect(sql.prepare("SELECT * FROM daily_stats_dirty").all()).toEqual([]);
});
