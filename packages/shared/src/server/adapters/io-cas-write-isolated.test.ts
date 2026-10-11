import { afterEach, expect, it, vi } from "vitest";
import { rejectSql } from "../../db/testing";
import {
  closeCasAdapters,
  INPUT,
  MESSAGES,
  openCasAdapter,
  poolCount,
  readInput,
  SMALL_INPUT,
  storedIo,
} from "./io-cas-write-helpers";
import { casWriteEnabledFor, resolveCasWriteConfig } from "./io-columns-decision";

/**
 * W5 写协议验收（CAS on 专属语义）：
 * 池发布与存在性确认、胜出判定（边界行为表 B1–B21 的关键行）与崩溃原子性。
 * 池一致性/隔离/写屏障/缓存/D-4 见 `io-cas-write-publish-isolated.test.ts`。
 *
 * CAS 默认 off 的行为由既有套件（`io-compression.test.ts` 等）以逐字节不变的方式覆盖，
 * 本文件只在 `PERIFUSE_IO_CAS_WRITE=on` 下断言新语义。
 */

afterEach(async () => {
  await closeCasAdapters();
  vi.unstubAllEnvs();
});

it("配置：CAS 开关默认 off、非法值明确报错、allowlist 空值=全部项目", () => {
  expect(resolveCasWriteConfig({}).enabled).toBe(false);
  expect(() => resolveCasWriteConfig({ PERIFUSE_IO_CAS_WRITE: "maybe" })).toThrow(
    "IO_CAS_INVALID_CONFIG",
  );
  const all = resolveCasWriteConfig({ PERIFUSE_IO_CAS_WRITE: "on" });
  expect(all.projects).toBeNull();
  expect(casWriteEnabledFor(all, "anything")).toBe(true);
  const gated = resolveCasWriteConfig({
    PERIFUSE_IO_CAS_WRITE: "off",
    PERIFUSE_IO_CAS_PROJECTS: " a , ,b ,",
  });
  expect([...(gated.projects ?? [])]).toEqual(["a", "b"]);
  expect(casWriteEnabledFor(gated, "a")).toBe(false); // 总开关 off 优先
  const on = resolveCasWriteConfig({
    PERIFUSE_IO_CAS_WRITE: "on",
    PERIFUSE_IO_CAS_PROJECTS: "a, b",
  });
  expect(casWriteEnabledFor(on, "a")).toBe(true);
  expect(casWriteEnabledFor(on, "c")).toBe(false);
  expect(casWriteEnabledFor(on, undefined)).toBe(false);
});

it("CAS 写入：三列组发布、池按去重内容入库，读回与原文逐字节一致", async () => {
  const adapter = await openCasAdapter("cas-write-roundtrip");
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        trace_id: "t",
        start_time: "2026-01-01 00:00:00",
        input: INPUT,
        output: "",
      },
    ],
  });
  const io = await storedIo(adapter, "o");
  expect(io.input_codec).toBe(2);
  expect(io.input_raw_size).toBe(Buffer.byteLength(INPUT, "utf8"));
  expect(io.stored).toBeLessThan(Buffer.byteLength(INPUT, "utf8"));
  // 每条唯一消息一行池内容（同 hash 只存一份）。
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  expect(await readInput(adapter, "o")).toBe(INPUT);
  // 幂等：同内容重复写入不新增池行。
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o2",
        trace_id: "t",
        start_time: "2026-01-01 00:00:01",
        input: INPUT,
        output: "",
      },
    ],
  });
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
});

it("非候选 input 对池 0 次查询：小正文、traces 表、项目不在 allowlist、output-only", async () => {
  const adapter = await openCasAdapter("cas-write-noncandidate");
  const db = adapter.getDatabase();
  // 池查询一旦发生即抛错：这几条写入必须全部成功。
  const forbidPool = rejectSql(db, /io_cas_chunks/i, vi);
  try {
    await adapter.insert({
      table: "observations",
      records: [
        {
          project_id: "p",
          id: "small",
          trace_id: "t",
          start_time: "2026-01-01 00:00:00",
          input: SMALL_INPUT,
        },
        {
          project_id: "p",
          id: "output",
          trace_id: "t",
          start_time: "2026-01-01 00:00:01",
          output: INPUT,
        },
        {
          project_id: "p",
          id: "nomessages",
          trace_id: "t",
          start_time: "2026-01-01 00:00:02",
          input: "x".repeat(20 * 1024),
        },
      ],
    });
    await adapter.insert({
      table: "traces",
      records: [{ project_id: "p", id: "t2", timestamp: "2026-01-01 00:00:00", input: INPUT }],
    });
    const gated = await openCasAdapter("cas-write-noncandidate-go", { projects: "other" });
    await gated.insert({
      table: "observations",
      records: [
        {
          project_id: "p",
          id: "gated",
          trace_id: "t",
          start_time: "2026-01-01 00:00:00",
          input: INPUT,
        },
      ],
    });
    expect(await poolCount(gated)).toBe(0);
  } finally {
    forbidPool.mockRestore();
  }
  expect(await poolCount(adapter)).toBe(0);
  expect((await storedIo(adapter, "small")).input_codec).toBe(0);
  expect((await storedIo(adapter, "output")).input_codec).toBe(0);
  expect((await storedIo(adapter, "nomessages")).input_codec).toBe(1);
  expect(
    (await db.get("SELECT input_codec FROM traces WHERE id='t2'")) as { input_codec: number },
  ).toEqual({ input_codec: 1 });
});

it("胜出判定：版本拒绝不发布、显式更新发布、未选中列不发布", async () => {
  const adapter = await openCasAdapter("cas-write-winner");
  const newer = "2099-03-01T00:00:00Z";
  // B4：显式更新列含 input（无 eventIds）→ 发布。
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        trace_id: "t",
        start_time: "2026-01-01 00:00:00",
        input: SMALL_INPUT,
      },
    ],
  });
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", input: INPUT, event_ts: newer, updated_at: newer }],
    updateColumns: [["input"]],
    eventIds: ["evt-1"],
  });
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  // B3：更旧的显式值被版本决策拒绝 → 不写、不发布。
  const stale = JSON.stringify({
    messages: [{ role: "user", content: `stale ${"y".repeat(900)}` }],
  });
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        input: stale,
        event_ts: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ],
    updateColumns: [["input"]],
    eventIds: ["evt-0"],
  });
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  // B7：input 未在显式更新列中 → 三列都不写，池不增长。
  const other = JSON.stringify({
    messages: [{ role: "user", content: `other ${"z".repeat(900)}` }],
  });
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        name: "renamed",
        input: other,
        event_ts: newer,
        updated_at: newer,
      },
    ],
    updateColumns: [["name"]],
    eventIds: ["evt-2"],
  });
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  expect(await readInput(adapter, "o")).toBe(INPUT);
  // 「其他字段仍可各自胜出」：name 更新生效，而 input 三列保持旧 manifest。
  expect(
    (await adapter
      .getDatabase()
      .get("SELECT name FROM observations WHERE project_id='p' AND id='o'")) as {
      name: string;
    },
  ).toEqual({ name: "renamed" });
});

it("B6：SQL CASE 继承分支只在旧值缺失时写入并发布", async () => {
  const adapter = await openCasAdapter("cas-write-inherit");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: null },
    ],
  });
  expect(await poolCount(adapter)).toBe(0);
  // 旧行 codec=0 且 input IS NULL：CASE 分支会写入 excluded.input → 必须发布。
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", input: INPUT }],
    updateColumns: [[]],
    inheritColumns: [["input"]],
  });
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  // B5/B21：已被版本决策接受过的行不会再被后续 inherit 覆盖（三列保持 codec 2）。
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", input: null }],
    updateColumns: [[]],
    inheritColumns: [["input"]],
  });
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  expect(await readInput(adapter, "o")).toBe(INPUT);
  expect(
    (await db.get("SELECT mark_epoch FROM io_cas_chunks WHERE project_id='p' LIMIT 1")) as {
      mark_epoch: number;
    },
  ).toEqual({ mark_epoch: 0 });
});

it("merge：候选覆盖发布、null 保持旧 manifest（三列不变、不需屏障）", async () => {
  const adapter = await openCasAdapter("cas-write-merge");
  await adapter.mergeInsert({
    table: "observations",
    records: [
      { project_id: "p", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  // B11：merge 显式 null → 三列保持旧值（codec 2 manifest 原样继承），池不增长。
  await adapter.mergeInsert({
    table: "observations",
    records: [{ project_id: "p", id: "o", input: null }],
  });
  expect((await storedIo(adapter, "o")).input_codec).toBe(2);
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  expect(await readInput(adapter, "o")).toBe(INPUT);
});

it("崩溃原子性：池插入或行写入任一步失败，两者一起回滚", async () => {
  const adapter = await openCasAdapter("cas-write-atomicity");
  const db = adapter.getDatabase();
  const poolFail = rejectSql(db, /INSERT INTO io_cas_chunks/i, vi);
  try {
    await expect(
      adapter.insert({
        table: "observations",
        records: [
          {
            project_id: "p",
            id: "o",
            trace_id: "t",
            start_time: "2026-01-01 00:00:00",
            input: INPUT,
          },
        ],
      }),
    ).rejects.toThrow("synthetic");
  } finally {
    poolFail.mockRestore();
  }
  expect(await db.get("SELECT id FROM observations WHERE id='o'")).toBeUndefined();
  expect(await poolCount(adapter)).toBe(0);

  const rowFail = rejectSql(db, /INTO observations/i, vi);
  try {
    await expect(
      adapter.insert({
        table: "observations",
        records: [
          {
            project_id: "p",
            id: "o",
            trace_id: "t",
            start_time: "2026-01-01 00:00:00",
            input: INPUT,
          },
        ],
      }),
    ).rejects.toThrow("synthetic");
  } finally {
    rowFail.mockRestore();
  }
  expect(await db.get("SELECT id FROM observations WHERE id='o'")).toBeUndefined();
  expect(await poolCount(adapter)).toBe(0);

  // 更新既有行：行写入失败时，旧行与本次补插的池内容一起回滚（无悬空根、无脏读回值）。
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  const freshInput = JSON.stringify({
    messages: Array.from({ length: 40 }, (_, index) => ({
      role: "user",
      content: `updated needle ${index} ${"u".repeat(600)}`,
    })),
  });
  const updateFail = rejectSql(db, /INTO observations/i, vi);
  try {
    await expect(
      adapter.insert({
        table: "observations",
        records: [
          {
            project_id: "p",
            id: "o",
            input: freshInput,
            event_ts: "2099-09-01T00:00:00Z",
            updated_at: "2099-09-01T00:00:00Z",
          },
        ],
        updateColumns: [["input"]],
        eventIds: ["evt-atomic"],
      }),
    ).rejects.toThrow("synthetic");
  } finally {
    updateFail.mockRestore();
  }
  expect(await poolCount(adapter)).toBe(MESSAGES.length);
  expect(await readInput(adapter, "o")).toBe(INPUT);
});
