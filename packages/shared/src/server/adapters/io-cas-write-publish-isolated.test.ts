import { afterEach, expect, it, vi } from "vitest";
import { withLocalTransaction } from "../../db/local";
import { rejectSql } from "../../db/testing";
import { CasPrepareCache, prepareCasInput } from "../io-cas/prepare";
import { hydrateIoRows } from "../io-cas/read";
import { IO_CAS_READ_BUDGET } from "../io-cas/reader-source";
import { markReferenced, publishCasInput } from "../io-cas/write";
import {
  closeCasAdapters,
  INPUT,
  MESSAGES,
  openCasAdapter,
  poolCount,
  readInput,
} from "./io-cas-write-helpers";
import { decodeIoRow } from "./io-compression";
import type { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

/**
 * W5 写协议验收（续）：池一致性（重读核验）、项目隔离、写屏障（W6 复用的
 * `markReferenced` 契约）、进程内缓存与 D-4 的 search_dirty 标记、CAS on/off 读回一致。
 * 写协议核心（发布、胜出判定、崩溃原子性）见 `io-cas-write-isolated.test.ts`。
 */

afterEach(async () => {
  await closeCasAdapters();
  vi.unstubAllEnvs();
});

it("池内容不一致：重读核验后仍不符即 IO_CAS_CORRUPT 并整事务回滚", async () => {
  const adapter = await openCasAdapter("cas-write-conflict");
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  const db = adapter.getDatabase();
  await db.run("UPDATE io_cas_chunks SET payload = ? WHERE project_id='p'", Buffer.from([0, 1, 2]));
  await expect(
    adapter.insert({
      table: "observations",
      records: [
        {
          project_id: "p",
          id: "o",
          trace_id: "t",
          start_time: "2026-01-01 00:00:02",
          input: INPUT,
          event_ts: "2099-05-01T00:00:00Z",
          updated_at: "2099-05-01T00:00:00Z",
        },
      ],
      updateColumns: [["input"]],
      eventIds: ["evt-late"],
    }),
  ).rejects.toThrow("IO_CAS_CORRUPT");
  expect(
    (await db.get("SELECT start_time FROM observations WHERE id='o'")) as { start_time: string },
  ).toEqual({ start_time: "2026-01-01 00:00:00" });
});

it("项目隔离：相同消息按项目各存一份；缺 project 的发布入口明确失败", async () => {
  const adapter = await openCasAdapter("cas-write-isolation");
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "a", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
      { project_id: "b", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  expect(await poolCount(adapter, "a")).toBe(MESSAGES.length);
  expect(await poolCount(adapter, "b")).toBe(MESSAGES.length);
  await expect(
    publishCasInput(adapter.getDatabase(), "", {
      manifest: Buffer.alloc(0),
      rawSize: 0,
      chunks: [],
      hashes: [],
      refCount: 0,
      literalBytes: 0,
    }),
  ).rejects.toThrow("IO_CAS_PROJECT_REQUIRED");
  await expect(markReferenced(adapter.getDatabase(), "", [Buffer.alloc(32)], 0)).rejects.toThrow(
    "IO_CAS_PROJECT_REQUIRED",
  );
});

it("写屏障 markReferenced：无状态/无 phase 不动，mark 时只更新旧 epoch 且幂等", async () => {
  const adapter = await openCasAdapter("cas-write-barrier");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  const [row] = (await db.all(
    "SELECT content_hash FROM io_cas_chunks WHERE project_id='p' LIMIT 1",
  )) as {
    content_hash: Uint8Array;
  }[];
  const hashes = [row.content_hash];
  const mark = async () =>
    Number(
      (
        (await db.get(
          "SELECT mark_epoch FROM io_cas_chunks WHERE project_id='p' AND content_hash=?",
          row.content_hash,
        )) as { mark_epoch: number }
      ).mark_epoch,
    );
  // 无状态行 → 0 次 UPDATE。
  expect(await markReferenced(db, "p", hashes, 5)).toBe(0);
  expect(await mark()).toBe(0);
  // phase=idle → 不动。
  await db.run("INSERT INTO io_cas_gc_state(project_id,epoch,phase) VALUES('p',3,'idle')");
  expect(await markReferenced(db, "p", hashes, 3)).toBe(0);
  expect(await mark()).toBe(0);
  // phase=mark：生效 epoch 取 max(state.epoch, 传入值)，只更新旧 epoch 行。
  await db.run("UPDATE io_cas_gc_state SET phase='mark' WHERE project_id='p'");
  expect(await markReferenced(db, "p", hashes, 1)).toBe(1);
  expect(await mark()).toBe(3);
  // 幂等：已达标 → 0 行。
  expect(await markReferenced(db, "p", hashes, 1)).toBe(0);
  // 空 hashes → 0。
  expect(await markReferenced(db, "p", [], 3)).toBe(0);
  // 集成路径：phase=mark 时，adapter 发布既有内容也必须把被引用的旧 epoch 行标到当前轮次。
  await db.run("UPDATE io_cas_gc_state SET phase='mark', epoch=7 WHERE project_id='p'");
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o2", trace_id: "t", start_time: "2026-01-01 00:00:09", input: INPUT },
    ],
  });
  expect(await mark()).toBe(7);
});

it("缓存：命中仍必须查库（池查询失败即失败），准备结果可复用且计费受限", async () => {
  const adapter = await openCasAdapter("cas-write-cache");
  const cache = new CasPrepareCache();
  const first = prepareCasInput(INPUT, { projectId: "p", cache });
  const second = prepareCasInput(INPUT, { projectId: "p", cache });
  expect(second).toBe(first);
  expect(cache.count).toBe(1);
  expect(cache.size).toBeGreaterThan(Buffer.byteLength(INPUT, "utf8") / 2);
  // 按项目键控：不同项目下同一原文各占一条（不跨项目共享）。
  prepareCasInput(INPUT, { projectId: "q", cache });
  expect(cache.count).toBe(2);
  const bounded = new CasPrepareCache(64);
  prepareCasInput(INPUT, { projectId: "p", cache: bounded });
  expect(bounded.size).toBe(0);
  expect(bounded.count).toBe(0);
  // 同一批里两条相同 input：第二条走缓存命中，但仍必须查池（注入池查询失败）。
  const db = adapter.getDatabase();
  const forbidPool = rejectSql(db, /FROM io_cas_chunks/i, vi);
  try {
    await expect(
      adapter.insert({
        table: "observations",
        records: [
          {
            project_id: "p",
            id: "o1",
            trace_id: "t",
            start_time: "2026-01-01 00:00:00",
            input: INPUT,
          },
          {
            project_id: "p",
            id: "o2",
            trace_id: "t",
            start_time: "2026-01-01 00:00:01",
            input: INPUT,
          },
        ],
      }),
    ).rejects.toThrow("synthetic");
  } finally {
    forbidPool.mockRestore();
  }
  expect(await poolCount(adapter)).toBe(0);
});

it("D-4：input 胜出后 search_dirty 标记覆盖 insert / 版本更新 / inherit / merge", async () => {
  const adapter = await openCasAdapter("cas-write-search-dirty");
  const db = adapter.getDatabase();
  const pending = async (id: string) =>
    Number(
      (
        (await db.get(
          "SELECT COUNT(*) AS n FROM search_dirty WHERE project_id='p' AND source_id=?",
          id,
        )) as { n: number }
      ).n,
    );
  const clear = () => db.run("DELETE FROM search_dirty WHERE project_id='p'");
  // insert（新行，input 胜出）
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  expect(await pending("o")).toBeGreaterThan(0);
  // 版本化更新（input 胜出）
  await clear();
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        input: INPUT,
        event_ts: "2099-06-01T00:00:00Z",
        updated_at: "2099-06-01T00:00:00Z",
      },
    ],
    updateColumns: [["input"]],
    eventIds: ["evt-search"],
  });
  expect(await pending("o")).toBeGreaterThan(0);
  // inherit（SQL CASE 分支写入）
  await clear();
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "inh", trace_id: "t", start_time: "2026-01-01 00:00:00", input: null },
    ],
    updateColumns: [["input"]],
  });
  await clear();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "inh", input: INPUT }],
    updateColumns: [[]],
    inheritColumns: [["input"]],
  });
  expect(await pending("inh")).toBeGreaterThan(0);
  // merge
  await clear();
  await adapter.mergeInsert({
    table: "observations",
    records: [
      { project_id: "p", id: "m", trace_id: "t", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  expect(await pending("m")).toBeGreaterThan(0);
});

it("CAS on 与 off 的读回语义逐字段一致", async () => {
  const on = await openCasAdapter("cas-write-parity-on", { cas: "on" });
  const off = await openCasAdapter("cas-write-parity-off", { cas: "off" });
  const record = {
    project_id: "p",
    id: "o",
    trace_id: "t",
    type: "GENERATION",
    name: "parity",
    start_time: "2026-01-01 00:00:00",
    input: INPUT,
    output: "out",
  };
  await on.insert({ table: "observations", records: [record] });
  await off.insert({ table: "observations", records: [record] });
  // 同一 decode 口径（hydrate + decodeIoRow）比较两种写入的读回结果：逐字段一致。
  const read = async (adapter: SQLiteTelemetryAdapter) => {
    const db = adapter.getDatabase();
    const row = (await db.get(
      "SELECT id,project_id,trace_id,type,name,start_time,input,input_codec,input_raw_size,output,output_codec,output_raw_size FROM observations WHERE project_id='p'",
    )) as Record<string, unknown>;
    await withLocalTransaction(db, (tx) => hydrateIoRows(tx, [row], IO_CAS_READ_BUDGET));
    return decodeIoRow(row);
  };
  expect(await read(on)).toEqual(await read(off));
  expect(await read(on)).toMatchObject({ input: INPUT, output: "out", name: "parity" });
  expect(await poolCount(off)).toBe(0);
  // `readInput` 是另一口径的读回 helper；在此确认 CAS on 行可被它读出原文。
  expect(await readInput(on, "o")).toBe(INPUT);
});
