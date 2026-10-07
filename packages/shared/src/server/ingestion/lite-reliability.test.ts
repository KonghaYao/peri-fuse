import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { rejectSql } from "@peri-fuse/shared/src/db/testing";
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
await db.initialize();
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
const row = async (projectId = "p") =>
  (await sql.get("SELECT * FROM observations WHERE project_id=? AND id='o'", projectId)) as Record<
    string,
    unknown
  >;

beforeEach(async () => {
  vi.restoreAllMocks();
  await sql.exec(
    "DELETE FROM search_dirty; DELETE FROM search_source_revisions; DELETE FROM search_index_state; DELETE FROM ingestion_field_versions; DELETE FROM observations; DELETE FROM traces; DELETE FROM scores; DELETE FROM trace_metrics; DELETE FROM daily_stats_dirty; DELETE FROM daily_stats; DELETE FROM daily_model_stats;",
  );
});
afterAll(async () => await db.close());

describe("真实 SQLite ingestion 可靠性", () => {
  it("版本状态与实体回滚一致，失败的新版本不能阻止旧字段补写", async () => {
    await run([event("a", { id: "o", traceId: "t", name: "old" })]);
    const before = await sql.all("SELECT * FROM ingestion_field_versions");
    const fault_fail_metrics = rejectSql(
      sql,
      /INSERT(?: OR REPLACE)?(?: INTO)?[\s"\x60]+trace_metrics/i,
      vi,
    );
    expect(
      (
        await run([
          event("z", { id: "o", name: "failed" }, "generation-update", "2026-03-01T00:00:00Z"),
        ])
      ).errors,
    ).toHaveLength(1);
    expect(await sql.all("SELECT * FROM ingestion_field_versions")).toEqual(before);
    fault_fail_metrics.mockRestore();
    await run([
      event("b", { id: "o", name: "valid" }, "generation-update", "2026-02-01T00:00:00Z"),
    ]);
    expect((await row()).name).toBe("valid");
  });
  it("迟到补字段、同时间稳定排序、历史无版本兼容", async () => {
    await run([
      event("z", { id: "o", output: "new" }, "generation-update", "2026-02-01T00:00:00Z"),
    ]);
    await run([event("a", { id: "o", input: "late", output: "old", name: "a" })]);
    expect(await row()).toMatchObject({ input: "late", output: "new", name: "a" });
    await run([event("b", { id: "o", name: "b" })]);
    await run([event("a", { id: "o", name: "a" })]);
    expect((await row()).name).toBe("b");
    await sql.exec("DELETE FROM ingestion_field_versions");
    await run([event("c", { id: "o", name: "older", statusMessage: "fill" })]);
    expect(await row()).toMatchObject({ name: "b", status_message: "fill" });
  });

  it("历史日桶与消失模型修复，派生失败不误报实体失败且可恢复", async () => {
    await run([event("a", { id: "o", startTime: "2020-01-01T00:00:00Z", model: "old" })]);
    expect((await loadMaterializedDays("p", null, null)).models.get("2020-01-01")?.[0].model).toBe(
      "old",
    );
    const fault_fail_daily = rejectSql(
      sql,
      /INSERT(?: OR REPLACE)?(?: INTO)?[\s"\x60]+daily_model_stats/i,
      vi,
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
      expect(await sql.get("SELECT COUNT(*) AS n FROM daily_stats_dirty WHERE dirty=1")).toEqual({
        n: 1,
      });
    } finally {
      fault_fail_daily.mockRestore();
    }
    const repaired = await loadMaterializedDays("p", null, null);
    expect(repaired.days.find((d) => d.day === "2020-01-01")?.observations).toBe(0);
    expect(repaired.models.has("2020-01-01")).toBe(false);
    expect(repaired.models.get("2020-02-01")?.[0].model).toBe("new");
    expect(await sql.get("SELECT COUNT(*) AS n FROM daily_stats_dirty WHERE dirty=1")).toEqual({
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
    const before = await row();
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
    const after = await row();
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
    expect(await row()).toMatchObject({ input: "keep", name: "", metadata: "{}" });
    expect(Number((await row()).output)).toBe(0);
    await run([event("c", { id: "o", name: "other" })], "other");
    expect((await row()).name).toBe("");
    expect((await row("other")).name).toBe("other");
    await run([event("t1", { id: "t", public: true, tags: ["x"] }, "trace-create")]);
    await run([event("t2", { id: "t", public: false, tags: [] }, "trace-create")]);
    expect(await sql.get("SELECT public,tags FROM traces WHERE project_id='p'")).toEqual({
      public: 0,
      tags: "[]",
    });
  });

  it("写入失败不报成功，其他表提交成功仍准确归属", async () => {
    const _fault_fail_write = rejectSql(
      sql,
      /INSERT(?: OR REPLACE)?(?: INTO)?[\s"\x60]+observations/i,
      vi,
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
    expect(await row()).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("synthetic failure");
  });

  it("dirty 失败回滚实体与之前的 revision", async () => {
    await run([event("a", { id: "o", name: "keep" })]);
    const revisions = await sql.all("SELECT * FROM search_source_revisions");
    const _fault_fail_dirty = rejectSql(
      sql,
      /INSERT(?: OR REPLACE)?(?: INTO)?[\s"\x60]+search_dirty/i,
      vi,
    );
    const result = await run([event("b", { id: "o", name: "lost" })]);
    expect(result.successes).toEqual([]);
    expect(result.errors[0]?.status).toBe(500);
    expect((await row()).name).toBe("keep");
    expect(await sql.all("SELECT * FROM search_source_revisions")).toEqual(revisions);
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
    expect(await row()).toMatchObject({ input: "keep", output: "new" });
    await run([update]);
    expect(await sql.get("SELECT COUNT(*) AS n FROM observations")).toEqual({ n: 1 });
    await run([create]);
    expect((await row()).output).toBe("new");
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
    const select = await sql.prepare(
      "SELECT name,environment,public,tags,input FROM traces WHERE project_id=? AND id='t'",
    );
    expect(await select.get("single")).toEqual(await select.get("split"));
    expect(await select.get("single")).toEqual({
      name: "keep",
      environment: "custom",
      public: 0,
      tags: "[]",
      input: "{}",
    });
  });

  it("metrics 跟随省略关联的 patch、关联迁移且保持项目隔离", async () => {
    const metrics = async (project = "p") =>
      await sql.all(
        "SELECT trace_id,input_tokens,input_cost FROM trace_metrics WHERE project_id=? ORDER BY trace_id",
        project,
      );
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
    expect(await metrics()).toEqual([{ trace_id: "a", input_tokens: 7, input_cost: 3 }]);
    await run([event("c", { id: "o", traceId: "b" }, "generation-update")]);
    expect(await metrics()).toEqual([{ trace_id: "b", input_tokens: 7, input_cost: 3 }]);
    expect(await metrics("other")).toEqual([{ trace_id: "a", input_tokens: 99, input_cost: 0 }]);
  });

  it("metrics 故障回滚实体、dirty 和汇总，返回失败且可重试", async () => {
    await run([event("a", { id: "o", traceId: "a", usageDetails: { input: 2 } })]);
    const before = await row();
    const metrics = await sql.all("SELECT * FROM trace_metrics");
    const revisions = await sql.all("SELECT * FROM search_source_revisions");
    const fault_fail_metrics = rejectSql(
      sql,
      /INSERT(?: OR REPLACE)?(?: INTO)?[\s"\x60]+trace_metrics/i,
      vi,
    );
    const update = event(
      "b",
      { id: "o", traceId: "b", usageDetails: { input: 7 } },
      "generation-update",
    );
    const result = await run([update]);
    expect(result.successes).toEqual([]);
    expect(result.errors).toMatchObject([{ id: "b", status: 500 }]);
    expect(await row()).toEqual(before);
    expect(await sql.all("SELECT * FROM trace_metrics")).toEqual(metrics);
    expect(await sql.all("SELECT * FROM search_source_revisions")).toEqual(revisions);
    fault_fail_metrics.mockRestore();
    expect((await run([update])).errors).toEqual([]);
    expect((await row()).trace_id).toBe("b");
  });

  it("已有 trace 条件继承不覆盖正文或显式空串", async () => {
    const get = async () =>
      await sql.get("SELECT input,output FROM traces WHERE project_id='p' AND id='t'");
    await run([event("t0", { id: "t" }, "trace-create")]);
    await run([
      event("t1", { id: "t" }, "trace-create"),
      event("o1", { id: "o", traceId: "t", input: "in", output: "out" }),
    ]);
    expect(await get()).toEqual({ input: "in", output: "out" });
    await run([
      event("t2", { id: "t" }, "trace-create"),
      event("o2", { id: "o", traceId: "t", input: "different", output: "different" }),
    ]);
    expect(await get()).toEqual({ input: "in", output: "out" });
    await run([
      event("t3", { id: "t", input: "" }, "trace-create"),
      event("o3", { id: "o", traceId: "t", input: "ignored" }),
    ]);
    expect(await get()).toEqual({ input: "", output: "out" });
  });

  it("legacy 显式类型可更新，现代事件缺失类型不覆盖", async () => {
    await run([event("a", { id: "o", type: "SPAN" }, "observation-create")]);
    expect(
      (await run([event("b", { id: "o", type: "GENERATION" }, "observation-update")])).errors,
    ).toEqual([]);
    expect((await row()).type).toBe("GENERATION");
    await run([event("c", { id: "o", name: "patch" }, "span-update")]);
    expect((await row()).type).toBe("GENERATION");
  });

  it("无实体 ID 的 score 重试使用稳定身份", async () => {
    const score = event(
      "score-envelope",
      { name: "synthetic", value: 0, traceId: "t" },
      "score-create",
    );
    expect((await run([score])).errors).toEqual([]);
    await run([score]);
    expect(await sql.get("SELECT COUNT(*) AS n FROM scores")).toEqual({ n: 1 });
  });
});
