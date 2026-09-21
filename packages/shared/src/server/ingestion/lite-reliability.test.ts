import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "../adapters/sqlite-telemetry-adapter";
import type { AuthHeaderValidVerificationResultIngestion } from "../auth/types";

vi.mock("../adapters", () => ({ getTelemetryDB: () => db }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { loadMaterializedDays } from "../stats/daily-stats";
import { processEventBatchLite } from "./processEventBatchLite";

if (!process.env.LANGFUSE_SQLITE_DB_PATH?.includes("peri-ingestion-test-")) {
  throw new Error("必须通过隔离测试入口运行");
}
const db = new SQLiteTelemetryAdapter(process.env.LANGFUSE_SQLITE_DB_PATH);
const sql = db.getDatabase();
const auth = (projectId = "p") =>
  ({
    validKey: true,
    scope: { projectId, accessLevel: "project" },
  }) as AuthHeaderValidVerificationResultIngestion;
const event = (
  id: string,
  body: Record<string, unknown>,
  type = "generation-create",
  timestamp = "2026-01-01T00:00:00Z",
) => ({ id, body, type, timestamp });
const run = (events: unknown[], projectId = "p") =>
  processEventBatchLite(events, auth(projectId), {
    attribution: {
      ingestionApiKey: "synthetic",
      ingestionSdkName: "test",
      ingestionSdkVersion: "1",
    },
  });
const row = (projectId = "p") =>
  sql.prepare("SELECT * FROM observations WHERE project_id=? AND id='o'").get(projectId) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  sql.exec(
    "DROP TRIGGER IF EXISTS fail_metrics; DROP TRIGGER IF EXISTS fail_write; DROP TRIGGER IF EXISTS fail_dirty; DELETE FROM ingestion_field_versions; DELETE FROM observations; DELETE FROM traces; DELETE FROM scores; DELETE FROM trace_metrics; DELETE FROM daily_stats_dirty; DELETE FROM daily_stats; DELETE FROM daily_model_stats;",
  );
});
afterAll(() => db.close());

describe("真实 SQLite ingestion 可靠性", () => {
  it("版本状态与实体回滚一致，失败的新版本不能阻止旧字段补写", async () => {
    await run([event("a", { id: "o", traceId: "t", name: "old" })]);
    const before = sql.prepare("SELECT * FROM ingestion_field_versions").all();
    sql.exec(
      "CREATE TRIGGER fail_metrics BEFORE INSERT ON trace_metrics BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    expect(
      (
        await run([
          event("z", { id: "o", name: "failed" }, "generation-update", "2026-03-01T00:00:00Z"),
        ])
      ).errors,
    ).toHaveLength(1);
    expect(sql.prepare("SELECT * FROM ingestion_field_versions").all()).toEqual(before);
    sql.exec("DROP TRIGGER fail_metrics");
    await run([
      event("b", { id: "o", name: "valid" }, "generation-update", "2026-02-01T00:00:00Z"),
    ]);
    expect(row().name).toBe("valid");
  });
  it("迟到补字段、同时间稳定排序、历史无版本兼容", async () => {
    await run([
      event("z", { id: "o", output: "new" }, "generation-update", "2026-02-01T00:00:00Z"),
    ]);
    await run([event("a", { id: "o", input: "late", output: "old", name: "a" })]);
    expect(row()).toMatchObject({ input: "late", output: "new", name: "a" });
    await run([event("b", { id: "o", name: "b" })]);
    await run([event("a", { id: "o", name: "a" })]);
    expect(row().name).toBe("b");
    sql.exec("DELETE FROM ingestion_field_versions");
    await run([event("c", { id: "o", name: "older", statusMessage: "fill" })]);
    expect(row()).toMatchObject({ name: "b", status_message: "fill" });
  });

  it("历史日桶与消失模型修复，派生失败不误报实体失败且可恢复", async () => {
    await run([event("a", { id: "o", startTime: "2020-01-01T00:00:00Z", model: "old" })]);
    expect((await loadMaterializedDays("p", null, null)).models.get("2020-01-01")?.[0].model).toBe(
      "old",
    );
    sql.exec(
      "CREATE TRIGGER fail_daily BEFORE INSERT ON daily_model_stats BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    try {
      expect(
        (
          await run([
            event("b", {
              id: "o",
              startTime: "2020-02-01T00:00:00Z",
              model: "new",
              traceId: "moved",
            }),
          ])
        ).errors,
      ).toEqual([]);
      await expect(loadMaterializedDays("p", null, null)).rejects.toThrow();
      expect(
        sql.prepare("SELECT COUNT(*) AS n FROM daily_stats_dirty WHERE dirty=1").get(),
      ).toEqual({ n: 1 });
    } finally {
      sql.exec("DROP TRIGGER fail_daily");
    }
    const repaired = await loadMaterializedDays("p", null, null);
    expect(repaired.days.find((d) => d.day === "2020-01-01")?.observations).toBe(0);
    expect(repaired.models.has("2020-01-01")).toBe(false);
    expect(repaired.models.get("2020-02-01")?.[0].model).toBe("new");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM daily_stats_dirty WHERE dirty=1").get()).toEqual({
      n: 0,
    });
  });
  it.each(["true", "", "unknown"])("压缩配置 %j 在数据库及目录创建前明确拒绝", (value) => {
    const previous = process.env.PERIFUSE_IO_COMPRESSION_WRITE;
    const directory = join(dirname(process.env.LANGFUSE_SQLITE_DB_PATH!), "blocked", value);
    try {
      process.env.PERIFUSE_IO_COMPRESSION_WRITE = value;
      expect(() => new SQLiteTelemetryAdapter(join(directory, "telemetry.db"))).toThrow(
        "IO_COMPRESSION_INVALID_CONFIG",
      );
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PERIFUSE_IO_COMPRESSION_WRITE;
      else process.env.PERIFUSE_IO_COMPRESSION_WRITE = previous;
    }
  });

  it("部分更新保留字段、created_at 和 schema 默认值", async () => {
    await run([
      event("a", {
        id: "o",
        traceId: "t",
        name: "original",
        input: { synthetic: true },
        metadata: { a: 1 },
        usage: { input: 3 },
        environment: "custom",
        level: "WARNING",
        startTime: "2025-01-01T00:00:00Z",
      }),
    ]);
    const before = row();
    expect(
      (
        await run([
          event(
            "b",
            { id: "o", output: "done", endTime: "2026-01-01T00:00:00Z" },
            "generation-update",
          ),
        ])
      ).errors,
    ).toEqual([]);
    const after = row();
    for (const key of [
      "trace_id",
      "name",
      "input",
      "metadata",
      "usage_details",
      "environment",
      "level",
      "start_time",
      "created_at",
    ])
      expect(after[key]).toEqual(before[key]);
    expect(after.output).toBe("done");
  });

  it("null 不覆盖，空值与 false/0 是值，项目隔离", async () => {
    await run([event("a", { id: "o", input: "keep", name: "keep" })]);
    await run([event("b", { id: "o", input: null, name: "", metadata: {}, output: 0 })]);
    expect(row()).toMatchObject({ input: "keep", name: "", metadata: "{}" });
    expect(Number(row().output)).toBe(0);
    await run([event("c", { id: "o", name: "other" })], "other");
    expect(row().name).toBe("");
    expect(row("other").name).toBe("other");
    await run([event("t1", { id: "t", public: true, tags: ["x"] }, "trace-create")]);
    await run([event("t2", { id: "t", public: false, tags: [] }, "trace-create")]);
    expect(sql.prepare("SELECT public,tags FROM traces WHERE project_id='p'").get()).toEqual({
      public: 0,
      tags: "[]",
    });
  });

  it("写入失败不报成功，其他表提交成功仍准确归属", async () => {
    sql.exec(
      "CREATE TRIGGER fail_write BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
    );
    const result = await run([
      event("a", { id: "o" }),
      event("b", { id: "o" }),
      event("t", { id: "t" }, "trace-create"),
      { id: "invalid" },
    ]);
    expect(result.successes).toEqual([{ id: "t", status: 201 }]);
    expect(result.errors.map((e) => [e.id, e.status])).toEqual([
      ["invalid", 400],
      ["a", 500],
      ["b", 500],
    ]);
    expect(row()).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("synthetic failure");
  });

  it("dirty 失败回滚实体与之前的 revision", async () => {
    await run([event("a", { id: "o", name: "keep" })]);
    const revisions = sql.prepare("SELECT * FROM search_source_revisions").all();
    sql.exec(
      "CREATE TRIGGER fail_dirty BEFORE INSERT ON search_dirty BEGIN SELECT RAISE(ABORT, 'synthetic dirty'); END;",
    );
    const result = await run([event("b", { id: "o", name: "lost" })]);
    expect(result.successes).toEqual([]);
    expect(result.errors[0]?.status).toBe(500);
    expect(row().name).toBe("keep");
    expect(sql.prepare("SELECT * FROM search_source_revisions").all()).toEqual(revisions);
  });

  it("批内与跨批倒序均按字段版本处理，重发不增加实体", async () => {
    const create = event("a", { id: "o", input: "keep", output: "old" });
    const update = event(
      "b",
      { id: "o", output: "new" },
      "generation-update",
      "2026-01-02T00:00:00Z",
    );
    await run([update, create]);
    expect(row()).toMatchObject({ input: "keep", output: "new" });
    await run([update]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 1 });
    await run([create]);
    expect(row().output).toBe("new");
  });

  it("trace 单批与拆批使用相同的显式字段规则", async () => {
    const events = [
      event(
        "t1",
        { id: "t", name: "keep", environment: "custom", public: true, tags: ["a"] },
        "trace-create",
      ),
      event("t2", { id: "t", tags: [], input: {}, public: false }, "trace-create"),
    ];
    await run(events, "single");
    for (const item of events) await run([item], "split");
    const select = sql.prepare(
      "SELECT name,environment,public,tags,input FROM traces WHERE project_id=? AND id='t'",
    );
    expect(select.get("single")).toEqual(select.get("split"));
    expect(select.get("single")).toEqual({
      name: "keep",
      environment: "custom",
      public: 0,
      tags: "[]",
      input: "{}",
    });
  });

  it("metrics 跟随省略关联的 patch、关联迁移且保持项目隔离", async () => {
    const metrics = (project = "p") =>
      sql
        .prepare(
          "SELECT trace_id,input_tokens,input_cost FROM trace_metrics WHERE project_id=? ORDER BY trace_id",
        )
        .all(project);
    await run([event("a", { id: "o", traceId: "a", usageDetails: { input: 2 } })]);
    await run([event("x", { id: "o", traceId: "a", usageDetails: { input: 99 } })], "other");
    expect(
      (
        await run([
          event(
            "b",
            { id: "o", usageDetails: { input: 7 }, costDetails: { input: 3 } },
            "generation-update",
          ),
        ])
      ).errors,
    ).toEqual([]);
    expect(metrics()).toEqual([{ trace_id: "a", input_tokens: 7, input_cost: 3 }]);
    await run([event("c", { id: "o", traceId: "b" }, "generation-update")]);
    expect(metrics()).toEqual([{ trace_id: "b", input_tokens: 7, input_cost: 3 }]);
    expect(metrics("other")).toEqual([{ trace_id: "a", input_tokens: 99, input_cost: 0 }]);
  });

  it("metrics 故障回滚实体、dirty 和汇总，返回失败且可重试", async () => {
    await run([event("a", { id: "o", traceId: "a", usageDetails: { input: 2 } })]);
    const before = row();
    const metrics = sql.prepare("SELECT * FROM trace_metrics").all();
    const revisions = sql.prepare("SELECT * FROM search_source_revisions").all();
    sql.exec(
      "CREATE TRIGGER fail_metrics BEFORE INSERT ON trace_metrics BEGIN SELECT RAISE(ABORT, 'synthetic metrics'); END;",
    );
    const update = event(
      "b",
      { id: "o", traceId: "b", usageDetails: { input: 7 } },
      "generation-update",
    );
    const result = await run([update]);
    expect(result.successes).toEqual([]);
    expect(result.errors).toMatchObject([{ id: "b", status: 500 }]);
    expect(row()).toEqual(before);
    expect(sql.prepare("SELECT * FROM trace_metrics").all()).toEqual(metrics);
    expect(sql.prepare("SELECT * FROM search_source_revisions").all()).toEqual(revisions);
    sql.exec("DROP TRIGGER fail_metrics");
    expect((await run([update])).errors).toEqual([]);
    expect(row().trace_id).toBe("b");
  });

  it("已有 trace 条件继承不覆盖正文或显式空串", async () => {
    const get = () =>
      sql.prepare("SELECT input,output FROM traces WHERE project_id='p' AND id='t'").get();
    await run([event("t0", { id: "t" }, "trace-create")]);
    await run([
      event("t1", { id: "t" }, "trace-create"),
      event("o1", { id: "o", traceId: "t", input: "in", output: "out" }),
    ]);
    expect(get()).toEqual({ input: "in", output: "out" });
    await run([
      event("t2", { id: "t" }, "trace-create"),
      event("o2", { id: "o", traceId: "t", input: "different", output: "different" }),
    ]);
    expect(get()).toEqual({ input: "in", output: "out" });
    await run([
      event("t3", { id: "t", input: "" }, "trace-create"),
      event("o3", { id: "o", traceId: "t", input: "ignored" }),
    ]);
    expect(get()).toEqual({ input: "", output: "out" });
  });

  it("legacy 显式类型可更新，现代事件缺失类型不覆盖", async () => {
    await run([event("a", { id: "o", type: "SPAN" }, "observation-create")]);
    expect(
      (await run([event("b", { id: "o", type: "GENERATION" }, "observation-update")])).errors,
    ).toEqual([]);
    expect(row().type).toBe("GENERATION");
    await run([event("c", { id: "o", name: "patch" }, "span-update")]);
    expect(row().type).toBe("GENERATION");
  });

  it("无实体 ID 的 score 重试使用稳定身份", async () => {
    const score = event(
      "score-envelope",
      { name: "synthetic", value: 0, traceId: "t" },
      "score-create",
    );
    expect((await run([score])).errors).toEqual([]);
    await run([score]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM scores").get()).toEqual({ n: 1 });
  });
});
