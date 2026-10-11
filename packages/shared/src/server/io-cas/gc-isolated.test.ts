import { afterEach, expect, it, vi } from "vitest";
import type { LocalDatabase } from "../../db/local";
import { withLocalTransaction } from "../../db/local";
import {
  closeCasAdapters,
  INPUT,
  MESSAGES,
  openCasAdapter,
} from "../adapters/io-cas-write-helpers";
import type { SQLiteTelemetryAdapter } from "../adapters/sqlite-telemetry-adapter";
import {
  CAS_GC_ROOT_BATCH,
  type CasGcStepResult,
  clearCasGcBlocked,
  ensureCasRootsIndex,
  runCasGcStep,
} from "./gc";
import {
  casGcJobActive,
  requestCasGcPass,
  resolveCasGcConfig,
  runCasGcPass,
  startCasGcJob,
} from "./gc-job";
import {
  assertRootsIntact,
  poolChunks,
  rawGcState,
  simulateVerifiedEngine,
} from "./gc-test-helpers";
import { encodeManifest } from "./manifest";
import { prepareCasInput } from "./prepare";
import { publishCasInput } from "./write";

/**
 * W6 GC 状态机与维护作业验收（CAS on 专属语义）。
 *
 * 测试跑在 Turso 引擎（W1 NO-GO）：门禁拒绝由专门用例覆盖，其余用例用
 * `simulateVerifiedEngine` 注册与生产 GO 引擎（bun:sqlite）等价的能力声明。
 * CAS 默认 off 的行为由既有套件覆盖，本文件只在 GC 开关下断言新语义。
 */

let current: SQLiteTelemetryAdapter | undefined;
vi.mock("../adapters", async (original) => ({
  ...(await original<typeof import("../adapters")>()),
  getTelemetryDB: () => {
    if (!current) throw new Error("test adapter is not open");
    return current;
  },
}));

afterEach(async () => {
  await closeCasAdapters();
  current = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 打开一个 CAS on 的隔离库，并声明（模拟）已验证的读快照引擎以放行 GC 门禁。 */
async function openGcAdapter(name: string): Promise<SQLiteTelemetryAdapter> {
  const adapter = await openCasAdapter(name);
  simulateVerifiedEngine(adapter.getDatabase());
  current = adapter;
  return adapter;
}

async function runUntilDone(
  db: LocalDatabase,
  projectId: string,
  limit = 64,
): Promise<CasGcStepResult[]> {
  const steps: CasGcStepResult[] = [];
  for (let index = 0; index < limit; index++) {
    const step = await runCasGcStep(db, projectId);
    steps.push(step);
    if (step.done) break;
  }
  return steps;
}

/** 直接落一行 codec 2 根（跳过写路径；用于构造精确的池/根形状）。 */
async function insertCodec2Row(
  db: LocalDatabase,
  projectId: string,
  id: string,
  manifest: Uint8Array,
  rawSize: number,
): Promise<void> {
  await db.run(
    `INSERT INTO observations(project_id, id, start_time, input, input_codec, input_raw_size)
     VALUES(?, ?, '2026-01-01 00:00:00', ?, 2, ?)`,
    projectId,
    id,
    manifest,
    rawSize,
  );
}

it("配置：GC 开关默认 off、非法值明确报错、on 才启用", () => {
  expect(resolveCasGcConfig({}).enabled).toBe(false);
  expect(resolveCasGcConfig({ PERIFUSE_IO_CAS_GC: "off" }).enabled).toBe(false);
  expect(resolveCasGcConfig({ PERIFUSE_IO_CAS_GC: "on" }).enabled).toBe(true);
  expect(() => resolveCasGcConfig({ PERIFUSE_IO_CAS_GC: "maybe" })).toThrow(
    "IO_CAS_INVALID_CONFIG",
  );
});

it("NO-GO 引擎：GC 入口显式拒绝，作业拒绝启动而非绕过门禁", async () => {
  // 不调用 simulateVerifiedEngine：真实 Turso 引擎（Turso local 未通过 W1 判据）。
  const adapter = await openCasAdapter("gc-no-go");
  current = adapter;
  const db = adapter.getDatabase();
  await expect(runCasGcStep(db, "p")).rejects.toThrow("verified read snapshot");
  await expect(runCasGcPass(db)).rejects.toThrow("verified read snapshot");
  await expect(ensureCasRootsIndex(db)).rejects.toThrow("verified read snapshot");
  await expect(clearCasGcBlocked(db, "p")).rejects.toThrow("verified read snapshot");
  vi.stubEnv("PERIFUSE_IO_CAS_GC", "on");
  const stop = startCasGcJob();
  expect(casGcJobActive()).toBe(false);
  await stop();
  requestCasGcPass(); // 作业未启动 → no-op，不抛错
});

it("GC off：作业与请求都不启动，行为与现状一致", async () => {
  await openGcAdapter("gc-off");
  const stop = startCasGcJob();
  expect(casGcJobActive()).toBe(false);
  requestCasGcPass();
  await stop();
});

it("状态机：idle→mark→sweep→idle，epoch 单调 +1、内容零误删", async () => {
  const adapter = await openGcAdapter("gc-roundtrip");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "o1", start_time: "2026-01-01 00:00:00", input: INPUT },
      { project_id: "p", id: "o2", start_time: "2026-01-01 00:00:01", input: INPUT },
    ],
  });
  expect(await rawGcState(db, "p")).toBeNull();
  const steps = await runUntilDone(db, "p");
  expect(steps.map((step) => step.phase)).toEqual(["mark", "mark", "sweep", "idle"]);
  expect(steps.map((step) => step.epoch)).toEqual([1, 1, 1, 1]);
  expect(steps.map((step) => step.done)).toEqual([false, false, false, true]);
  expect(steps[1].roots).toBe(2);
  expect(await rawGcState(db, "p")).toMatchObject({
    epoch: 1,
    phase: "idle",
    rootCursor: null,
    lastError: null,
  });
  expect((await poolChunks(db, "p")).size).toBe(MESSAGES.length);
  await assertRootsIntact(
    db,
    "p",
    new Map([
      ["o1", INPUT],
      ["o2", INPUT],
    ]),
  );
});

it("每步独立事务内重读 state：落后的驱动者不会回写 mark、也不会重复 +epoch", async () => {
  const adapter = await openGcAdapter("gc-reread");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", start_time: "2026-01-01 00:00:00", input: INPUT }],
  });
  // 驱动者 A 只迈出第一步（idle→mark，epoch=1）。
  const first = await runCasGcStep(db, "p");
  expect(first).toMatchObject({ phase: "mark", epoch: 1, done: false });
  // 驱动者 B 在此之后把项目推进到 sweep 并完成清扫（模拟另一进程跑得更快）。
  await runUntilDone(db, "p");
  expect(await rawGcState(db, "p")).toMatchObject({ epoch: 1, phase: "idle" });
  // 驱动者 A 带着"上次看到 phase=mark"的陈旧认知再迈一步：必须按当前 idle 起新一轮。
  const after = await runCasGcStep(db, "p");
  expect(after).toMatchObject({ phase: "mark", epoch: 2, done: false });
  expect(await rawGcState(db, "p")).toMatchObject({ epoch: 2, phase: "mark" });
  await runUntilDone(db, "p");
  await assertRootsIntact(db, "p", new Map([["o", INPUT]]));
});

it("epoch 达安全整数上限：停止 GC 并 blocked，绝不归零重用", async () => {
  const adapter = await openGcAdapter("gc-epoch-cap");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", start_time: "2026-01-01 00:00:00", input: INPUT }],
  });
  const before = await poolChunks(db, "p");
  await db.run(
    `INSERT INTO io_cas_gc_state(project_id, epoch, phase) VALUES('p', ?, 'idle')
     ON CONFLICT(project_id) DO UPDATE SET epoch=excluded.epoch, phase='idle'`,
    Number.MAX_SAFE_INTEGER,
  );
  const step = await runCasGcStep(db, "p");
  expect(step).toMatchObject({ phase: "blocked", done: true, epoch: Number.MAX_SAFE_INTEGER });
  expect(step.blocked).toBe("IO_CAS_GC_EPOCH_EXHAUSTED");
  expect(await rawGcState(db, "p")).toMatchObject({
    epoch: Number.MAX_SAFE_INTEGER,
    phase: "blocked",
    lastError: "IO_CAS_GC_EPOCH_EXHAUSTED",
  });
  // 池内容一行都不能少（归零重用会让在用内容变成垃圾，这里连 sweep 都不允许发生）。
  expect((await poolChunks(db, "p")).size).toBe(before.size);
  expect((await runCasGcStep(db, "p")).done).toBe(true);
  await assertRootsIntact(db, "p", new Map([["o", INPUT]]));
});

it("mark：批 64 根、keyset 游标不吃 OFFSET；游标前插入的新内容由写屏障保护", async () => {
  const adapter = await openGcAdapter("gc-mark-cursor");
  const db = adapter.getDatabase();
  // 70 个根共享同一份内容（第 1 个走真实写路径发布池内容，其余直接落行）。
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "root-000", start_time: "2026-01-01 00:00:00", input: INPUT }],
  });
  for (let index = 1; index < 70; index++) {
    const id = `root-${String(index).padStart(3, "0")}`;
    await db.run(
      `INSERT INTO observations(project_id, id, start_time, input, input_codec, input_raw_size)
       SELECT project_id, ?, '2026-01-01 00:00:00', input, 2, input_raw_size
       FROM observations WHERE project_id='p' AND id='root-000'`,
      id,
    );
  }
  expect(await runCasGcStep(db, "p")).toMatchObject({ phase: "mark", epoch: 1 });
  const batch = await runCasGcStep(db, "p");
  expect(batch.roots).toBe(CAS_GC_ROOT_BATCH);
  expect((await rawGcState(db, "p"))?.rootCursor).toBe("root-063");
  // 游标之前插入新根（字典序 root-050x < root-063）：本轮根扫描不会再看到它，
  // 内容只能靠同事务写屏障保住 —— sweep 后它必须完好。
  const updated = INPUT.replace(/x/g, "y");
  const prepared = prepareCasInput(updated, { projectId: "p" });
  expect(prepared).toBeDefined();
  await withLocalTransaction(db, async (tx) => {
    await publishCasInput(tx, "p", prepared!);
    await tx.run(
      `INSERT INTO observations(project_id, id, start_time, input, input_codec, input_raw_size)
       VALUES('p', 'root-050x', '2026-01-01 00:00:00', ?, 2, ?)`,
      prepared!.manifest,
      prepared!.rawSize,
    );
  });
  // 游标之后插入新根：会被后续批次扫到。
  await db.run(
    `INSERT INTO observations(project_id, id, start_time, input, input_codec, input_raw_size)
     SELECT project_id, 'root-070', '2026-01-01 00:00:00', input, 2, input_raw_size
     FROM observations WHERE project_id='p' AND id='root-000'`,
  );
  const rest = (await runUntilDone(db, "p")).filter(
    (step) => step.phase === "mark" && step.roots > 0,
  );
  expect(rest.map((step) => step.roots)).toEqual([7]);
  const byId = new Map<string, string>();
  for (let index = 0; index < 70; index++)
    byId.set(`root-${String(index).padStart(3, "0")}`, INPUT);
  byId.set("root-050x", updated);
  byId.set("root-070", INPUT);
  await assertRootsIntact(db, "p", byId);
  expect(await rawGcState(db, "p")).toMatchObject({ phase: "idle", epoch: 1 });
});

it("mark：单个超预算根独占一批，其余根按预算取前缀", async () => {
  const adapter = await openGcAdapter("gc-mark-budget");
  const db = adapter.getDatabase();
  // 三个根各含一个 LITERAL（无 REF）；manifest 不压缩，预算按实际存储字节动态设定：
  // 前两个恰好放得下，第三个超过预算独占一批。
  const texts = [2_000, 2_000, 6_000].map((size, index) =>
    Array.from({ length: size }, (_, i) => "0123456789abcdef"[(i * 7 + index * 3) % 16]).join(""),
  );
  for (const [index, text] of texts.entries()) {
    const bytes = Buffer.from(text, "utf8");
    const manifest = encodeManifest([{ tag: "literal", bytes }], bytes, { compress: false });
    await insertCodec2Row(db, "p", `lit-${index}`, manifest, bytes.byteLength);
  }
  const sizes = (await db.all(
    "SELECT id, length(input) AS bytes FROM observations WHERE project_id='p' AND input_codec=2 ORDER BY id",
  )) as { id: string; bytes: number }[];
  expect(sizes.map((row) => row.id)).toEqual(["lit-0", "lit-1", "lit-2"]);
  const budget = Number(sizes[0].bytes) + Number(sizes[1].bytes);
  expect(Number(sizes[2].bytes)).toBeGreaterThan(budget);
  await runCasGcStep(db, "p"); // idle → mark
  expect((await runCasGcStep(db, "p", { decodeBudgetBytes: budget })).roots).toBe(2);
  expect((await runCasGcStep(db, "p", { decodeBudgetBytes: budget })).roots).toBe(1);
  expect(await runCasGcStep(db, "p", { decodeBudgetBytes: budget })).toMatchObject({
    phase: "sweep",
    roots: 0,
  });
  await runUntilDone(db, "p");
  await assertRootsIntact(db, "p", new Map(texts.map((text, index) => [`lit-${index}`, text])));
});

it("坏 manifest：blocked 并记 last_error，绝不进入 sweep；复位后重新全量 mark", async () => {
  const adapter = await openGcAdapter("gc-blocked");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "good", start_time: "2026-01-01 00:00:00", input: INPUT }],
  });
  await insertCodec2Row(db, "p", "zz-corrupt", Buffer.from(`PFIC${"9".repeat(96)}`), 100);
  const poolBefore = await poolChunks(db, "p");
  const steps = await runUntilDone(db, "p");
  const blocked = steps[steps.length - 1];
  expect(blocked).toMatchObject({ phase: "blocked", done: true, swept: 0 });
  expect(blocked.blocked).toMatch(/^IO_CAS_(VERSION|INVALID|CORRUPT) root=zz-corrupt$/);
  const state = await rawGcState(db, "p");
  expect(state?.phase).toBe("blocked");
  expect(state?.lastError).toContain("root=zz-corrupt");
  // 没有 sweep：所有池内容原样保留（坏根绝不触发删除）。
  expect((await poolChunks(db, "p")).size).toBe(poolBefore.size);
  expect((await runCasGcStep(db, "p")).phase).toBe("blocked");
  expect(await clearCasGcBlocked(db, "p")).toBe(true);
  expect(await clearCasGcBlocked(db, "p")).toBe(false);
  // 复位后从 epoch+1 重新全量 mark；坏行仍在 → 再次 blocked（人工修复行后再复位）。
  expect(await runCasGcStep(db, "p")).toMatchObject({ phase: "mark", epoch: 2 });
  const again = await runUntilDone(db, "p");
  expect(again[again.length - 1].phase).toBe("blocked");
  expect((await poolChunks(db, "p")).size).toBe(poolBefore.size);
});

it("sweep：条件删除只清未达当前 epoch 的内容", async () => {
  const adapter = await openGcAdapter("gc-sweep");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", start_time: "2026-01-01 00:00:00", input: INPUT }],
  });
  const live = await poolChunks(db, "p");
  // 在用内容已被写屏障提升到当前 epoch；孤儿内容停在旧 epoch。
  await db.run("UPDATE io_cas_chunks SET mark_epoch=1 WHERE project_id='p'");
  const orphan = Buffer.alloc(32, 7);
  await db.run(
    `INSERT INTO io_cas_chunks(project_id, content_hash, codec, raw_size, payload, mark_epoch)
     VALUES('p', ?, 0, 3, ?, 0)`,
    orphan,
    Buffer.from("old"),
  );
  await db.run(
    `INSERT INTO io_cas_gc_state(project_id, epoch, phase) VALUES('p', 1, 'sweep')
     ON CONFLICT(project_id) DO UPDATE SET epoch=1, phase='sweep', sweep_cursor=NULL`,
  );
  expect(await runCasGcStep(db, "p")).toMatchObject({ phase: "idle", done: true, swept: 1 });
  const after = await poolChunks(db, "p");
  expect(after.has(Buffer.from(orphan).toString("hex"))).toBe(false);
  expect(after.size).toBe(live.size);
  await assertRootsIntact(db, "p", new Map([["o", INPUT]]));
});
