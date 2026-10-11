import type { Transaction } from "@tursodatabase/database";
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
import { purgeOlderThan, RETENTION_CHUNK_ROWS, runRetentionOnce } from "../stats/retention";
import { type CasGcStepResult, runCasGcStep } from "./gc";
import { casGcJobActive, runCasGcPass, startCasGcJob } from "./gc-job";
import {
  assertRootsIntact,
  poolChunks,
  rawGcState,
  simulateVerifiedEngine,
} from "./gc-test-helpers";
import { collectRefHashes, parseManifest } from "./manifest";
import { prepareCasInput } from "./prepare";
import { markReferenced, publishCasInput } from "./write";

/**
 * W6 维护作业验收（续）：空间性质、软删除根、项目隔离、pass 预算与 D-1 索引、
 * retention 的有界删除与"完成后请求一次 GC"，以及 ≥100 万次交错的 fuzz
 * （会话内默认 2 万次，验收运行用 `PERIFUSE_CAS_GC_FUZZ_EVENTS` 放大）。
 * 状态机与 mark/sweep 单步语义见 `gc-isolated.test.ts`。
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

/** 「空间」断言：池里的内容恰好等于在用根引用的集合（无多余无根内容）。 */
async function assertPoolExactlyReferenced(
  db: LocalDatabase,
  projectId: string,
  expected: ReadonlyMap<string, string>,
): Promise<number> {
  await assertRootsIntact(db, projectId, expected);
  const pool = await poolChunks(db, projectId);
  const rows = (await db.all(
    "SELECT id, input FROM observations WHERE project_id = ? AND input_codec = 2",
    projectId,
  )) as { id: string; input: Uint8Array }[];
  const live = new Set<string>();
  for (const row of rows)
    for (const key of collectRefHashes(parseManifest(row.input))) live.add(key.hex);
  expect([...pool.keys()].sort()).toEqual([...live].sort());
  return pool.size;
}

/** 轮询等待异步维护作业的可见结果（真实定时器）。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("空间：两轮 GC 后无多余无根内容，对在用引用零误删", async () => {
  const adapter = await openGcAdapter("gc-space");
  const db = adapter.getDatabase();
  const second = INPUT.replace(/x/g, "y");
  const third = INPUT.replace(/x/g, "z");
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "keep", start_time: "2026-01-01 00:00:00", input: INPUT },
      { project_id: "p", id: "gone", start_time: "2026-01-01 00:00:01", input: second },
      { project_id: "p", id: "replaced", start_time: "2026-01-01 00:00:02", input: third },
    ],
  });
  // 硬删除一个根（retention/prune 的等价动作）；另一个根的旧内容被 merge 替换。
  await db.run("DELETE FROM observations WHERE project_id='p' AND id='gone'");
  await adapter.mergeInsert({
    table: "observations",
    records: [{ project_id: "p", id: "replaced", input: INPUT }],
  });
  const live = new Map([
    ["keep", INPUT],
    ["replaced", INPUT],
  ]);
  const pass1 = await runCasGcPass(db, { budgetMs: 60_000, yieldBetween: () => {} });
  expect(pass1).toMatchObject({ blocked: [], indexCreated: true, budgetExhausted: false });
  expect(pass1.swept).toBeGreaterThan(0);
  const afterFirst = await assertPoolExactlyReferenced(db, "p", live);
  const pass2 = await runCasGcPass(db, { budgetMs: 60_000, yieldBetween: () => {} });
  expect(pass2.swept).toBe(0);
  expect(await assertPoolExactlyReferenced(db, "p", live)).toBe(afterFirst);
});

it("软删除行仍作根：is_deleted=1 的根同样保护其内容", async () => {
  const adapter = await openGcAdapter("gc-soft-delete");
  const db = adapter.getDatabase();
  const second = INPUT.replace(/x/g, "y");
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "p", id: "soft", start_time: "2026-01-01 00:00:00", input: INPUT },
      { project_id: "p", id: "other", start_time: "2026-01-01 00:00:01", input: second },
    ],
  });
  // 只留下软删除的根；池内容回到"上一轮已标记"的形态。
  await db.run("DELETE FROM observations WHERE project_id='p' AND id='other'");
  await db.run("UPDATE observations SET is_deleted=1 WHERE project_id='p' AND id='soft'");
  await db.run("UPDATE io_cas_chunks SET mark_epoch=0 WHERE project_id='p'");
  await runUntilDone(db, "p");
  await assertRootsIntact(db, "p", new Map([["soft", INPUT]]));
  // 无根内容（other 的块）确实被清掉了 —— 说明本轮 sweep 真的在删东西。
  expect((await poolChunks(db, "p")).size).toBe(MESSAGES.length);
});

it("项目隔离：GC 只在自己的项目内标记与删除", async () => {
  const adapter = await openGcAdapter("gc-isolation");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [
      { project_id: "a", id: "o", start_time: "2026-01-01 00:00:00", input: INPUT },
      { project_id: "b", id: "o", start_time: "2026-01-01 00:00:00", input: INPUT },
    ],
  });
  const before = await poolChunks(db, "b");
  await runUntilDone(db, "a");
  expect(await rawGcState(db, "b")).toBeNull();
  expect((await poolChunks(db, "b")).size).toBe(before.size);
  for (const chunk of (await poolChunks(db, "b")).values()) expect(chunk.markEpoch).toBe(0);
  await assertRootsIntact(db, "b", new Map([["o", INPUT]]));
});

it("pass：有界预算下续跑不丢进度；D-1 的根扫描索引在首次 mark 前显式建立", async () => {
  const adapter = await openGcAdapter("gc-pass-budget");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "root-000", start_time: "2026-01-01 00:00:00", input: INPUT }],
  });
  for (let index = 1; index < 70; index++) {
    await db.run(
      `INSERT INTO observations(project_id, id, start_time, input, input_codec, input_raw_size)
       SELECT project_id, ?, '2026-01-01 00:00:00', input, 2, input_raw_size
       FROM observations WHERE project_id='p' AND id='root-000'`,
      `root-${String(index).padStart(3, "0")}`,
    );
  }
  const indexSql = "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_obs_cas_roots'";
  expect(await db.get(indexSql)).toBeUndefined();
  const first = await runCasGcPass(db, { maxSteps: 2, budgetMs: 60_000, yieldBetween: () => {} });
  expect(first).toMatchObject({
    projects: 1,
    steps: 2,
    indexCreated: true,
    budgetExhausted: true,
  });
  expect(await db.get(indexSql)).toBeDefined();
  expect((await rawGcState(db, "p"))?.phase).toBe("mark");
  const second = await runCasGcPass(db, { budgetMs: 60_000, yieldBetween: () => {} });
  expect(second).toMatchObject({ indexCreated: false, budgetExhausted: false, steps: 3 });
  expect(await rawGcState(db, "p")).toMatchObject({ phase: "idle", epoch: 1 });
  const byId = new Map<string, string>();
  for (let index = 0; index < 70; index++)
    byId.set(`root-${String(index).padStart(3, "0")}`, INPUT);
  await assertPoolExactlyReferenced(db, "p", byId);
});

it("retention：按项目有界删除（初始 500 行/批），不再是整表 50,000 行一把梭", async () => {
  const adapter = await openGcAdapter("gc-retention-batch");
  const db = adapter.getDatabase();
  // 单条 INSERT 落 1205 行：p 有 1195 行过期 + 5 行未过期，q 有 10 行过期。
  const values: string[] = [];
  for (let index = 0; index < 1_205; index++) {
    const project = index >= 1_200 ? "q" : "p";
    const old = index >= 1_200 || index < 1_195;
    values.push(
      `('${project}', '${project}-${String(index).padStart(4, "0")}', '${old ? "2020-01-01 00:00:00" : "2099-01-01 00:00:00"}')`,
    );
  }
  await db.exec(`INSERT INTO observations(project_id, id, start_time) VALUES${values.join(",")}`);
  const spy = vi.spyOn(adapter, "command");
  // 项目发现与每个项目的删除都必须走索引（project_id 是索引前缀），
  // 否则"按项目有界删除"只是把全表扫描切成更多次。
  const planOf = async (query: string) =>
    ((await db.all(`EXPLAIN QUERY PLAN ${query}`)) as { detail: string }[])
      .map((row) => row.detail.toUpperCase())
      .join(" ");
  expect(await planOf("SELECT DISTINCT project_id FROM observations ORDER BY project_id")).toMatch(
    /USING (COVERING )?INDEX/,
  );
  expect(
    await planOf(
      "SELECT rowid FROM observations WHERE project_id='p' AND start_time<'2026-01-01' LIMIT 500",
    ),
  ).toMatch(/USING (COVERING )?INDEX/);
  const deleted = await purgeOlderThan("2026-01-01 00:00:00.000");
  const batches = spy.mock.calls
    .map(([opts]) => String((opts as { query: string }).query))
    .filter((query) => query.startsWith("DELETE FROM observations"));
  expect(batches).toHaveLength(4); // p: 500 + 500 + 195 → 3 批；q: 1 批 5 行
  expect(batches.every((query) => query.includes(`LIMIT ${RETENTION_CHUNK_ROWS}`))).toBe(true);
  expect(deleted.observations).toBe(1_200);
  expect(await db.get("SELECT COUNT(*) AS n FROM observations WHERE project_id='q'")).toMatchObject(
    { n: 0 },
  );
  expect(await db.get("SELECT COUNT(*) AS n FROM observations WHERE project_id='p'")).toMatchObject(
    { n: 5 },
  );
  expect(
    await db.get(
      "SELECT COUNT(*) AS n FROM observations WHERE project_id='p' AND start_time<'2026-01-01'",
    ),
  ).toMatchObject({ n: 0 });
}, 60_000);

it("作业：默认 6h 巡检；retention 完成后请求一次并立即补跑一轮", async () => {
  vi.stubEnv("PERIFUSE_IO_CAS_GC", "on");
  vi.stubEnv("PERIFUSE_TELEMETRY_RETENTION_DAYS", "30");
  const adapter = await openGcAdapter("gc-job-request");
  const db = adapter.getDatabase();
  await adapter.insert({
    table: "observations",
    records: [{ project_id: "p", id: "o", start_time: "2099-01-01 00:00:00", input: INPUT }],
  });
  const stop = startCasGcJob({
    intervalMs: 6 * 3600_000,
    pass: { budgetMs: 60_000, yieldBetween: () => {} },
  });
  expect(casGcJobActive()).toBe(true);
  await waitFor(async () => (await rawGcState(db, "p"))?.phase === "idle");
  const firstRoundEnded = (await rawGcState(db, "p"))?.epoch;
  expect(firstRoundEnded).toBe(1);
  // idle 期写入的新内容：写屏障不动，只能靠下一轮 mark 保护。
  await adapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o2",
        start_time: "2099-01-01 00:00:01",
        input: INPUT.replace(/x/g, "y"),
      },
    ],
  });
  await runRetentionOnce();
  await waitFor(
    async () =>
      (await rawGcState(db, "p"))?.phase === "idle" && (await rawGcState(db, "p"))?.epoch === 2,
  );
  await stop();
  expect(casGcJobActive()).toBe(false);
  await assertRootsIntact(
    db,
    "p",
    new Map([
      ["o", INPUT],
      ["o2", INPUT.replace(/x/g, "y")],
    ]),
  );
});

it("交错 fuzz：写路径 vs mark/sweep 交错，零误删（≥100 万次见验收运行）", async () => {
  const events = Number(process.env.PERIFUSE_CAS_GC_FUZZ_EVENTS ?? 0) || 15_000;
  const adapter = await openGcAdapter("gc-fuzz");
  const db = adapter.getDatabase();
  // 交错验收只看事务/可见性语义（零误删），不看落盘持久性：关掉 fsync 才能把
  // ≥100 万次交错压进可运行时间。事务边界与锁语义完全不变。
  await db.exec("PRAGMA synchronous=OFF");
  // 卫生措施（与 GC 语义无关）：adapter 每 10 分钟跑一次查询统计维护，缺统计的表会
  // 在长跑中途执行 ANALYZE 抢写锁。这里先给非空表建好统计（之后该作业是只读的），
  // 并把本连接的重试窗口放大，避免把环境级瞬时冲突记成 GC 故障。
  await db.exec("PRAGMA busy_timeout = 60000");
  const projectId = "p";
  // 世界：6 个根槽位，内容由 8 条消息的随机组合构成（同 hash 在项目内共享池内容）。
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `fuzz-${index} ${"z".repeat(600)}`,
  }));
  // 每个根引用 8 条消息里的一个子集（2..6 条，重复填充到 ≥16KiB 的候选正文）：
  // 删掉一个根会真的让部分内容失去引用，sweep 才有东西可删。
  const buildInput = (pick: number) => {
    const count = 2 + (pick % 5);
    const start = pick % messages.length;
    const chosen = Array.from(
      { length: count },
      (_, index) => messages[(start + index * 3) % messages.length],
    );
    return JSON.stringify({
      messages: Array.from({ length: 48 }, (_, index) => chosen[index % chosen.length]),
    });
  };
  const ids = Array.from({ length: 6 }, (_, index) => `f-${index}`);
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const expected = new Map<string, string>();
  let poolHashes: Uint8Array[] = [];
  const refreshPool = async () => {
    poolHashes = (
      (await db.all("SELECT content_hash FROM io_cas_chunks WHERE project_id = ?", projectId)) as {
        content_hash: Uint8Array;
      }[]
    ).map((row) => row.content_hash);
  };
  interface PlannedWrite {
    id: string;
    input: string;
    prepared: NonNullable<ReturnType<typeof prepareCasInput>>;
  }
  const prepareWrite = (id: string, input: string): PlannedWrite => {
    const prepared = prepareCasInput(input, { projectId });
    if (!prepared) throw new Error("fuzz 输入必须是 CAS 候选");
    return { id, input, prepared };
  };
  /** 一个写者操作 = 池发布 + 同事务写根（与 adapter.insert 的写入协议等价）。 */
  const applyWrite = async (tx: Transaction, write: PlannedWrite) => {
    await publishCasInput(tx, projectId, write.prepared);
    await tx.run(
      `INSERT INTO observations(project_id, id, start_time, input, input_codec, input_raw_size)
       VALUES(?, ?, '2026-01-01 00:00:00', ?, 2, ?)
       ON CONFLICT(project_id, id) DO UPDATE
         SET input=excluded.input, input_codec=2, input_raw_size=excluded.input_raw_size`,
      projectId,
      write.id,
      write.prepared.manifest,
      write.prepared.rawSize,
    );
    expected.set(write.id, write.input);
  };
  await withLocalTransaction(db, async (tx) => {
    for (const id of ids) await applyWrite(tx, prepareWrite(id, buildInput(Number(id.slice(2)))));
  });
  await refreshPool();
  await db.exec("ANALYZE"); // 见上：让 10 分钟一次的统计维护提前变成只读
  const check = () => assertRootsIntact(db, projectId, expected);
  // 分类计时 + 单事务上界（原始数据进报告：交错成本与"维护事务 ≤25ms"目标）。
  const spent = { writerTx: 0, gc: 0, check: 0 };
  const maxMs = { writerTx: 0, gc: 0 };
  const clock = async <T>(key: keyof typeof spent, run: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    const value = await run();
    const delta = performance.now() - at;
    spent[key] += delta;
    if (key !== "check") maxMs[key] = Math.max(maxMs[key], delta);
    return value;
  };
  /**
   * 卫生措施（与 GC 语义无关）：adapter 每 10 分钟对"缺统计的非空表"执行 ANALYZE。
   * 在 ≥100 万次交错的长跑里，这条旁路作业会与高频短事务在同一连接上交错：实测先出现
   * `database is locked`，进而在驱动层挂起。这里只屏蔽这条维护语句（短跑用例不触发它，
   * 生产在 bun:sqlite 上是另一条驱动路径），GC 与写路径的行为不变。
   */
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation(((sql: string) =>
    /^\s*analyze\b/i.test(sql) ? Promise.resolve() : exec(sql)) as typeof db.exec);
  const stats = { writerOps: 0, writerTx: 0, gcSteps: 0, swept: 0, checks: 0 };
  const started = performance.now();
  let index = 0;
  let nextCheck = 20_000;
  let nextProgress = 100_000;
  while (index < events) {
    if (rand() < 0.6) {
      // GC 的一步：独立事务，与写者批随机交错。
      const step = await clock("gc", () => runCasGcStep(db, projectId));
      index += 1;
      stats.gcSteps += 1;
      stats.swept += step.swept;
      // 只要这一步真的删了池内容，就立刻做一次"在用内容零误删"全量断言。
      if (step.swept > 0) {
        await clock("check", check);
        stats.checks += 1;
      }
    } else {
      // 写者批：生产 ingestion 也是"一批行 + 池发布"在同一事务里提交，
      // 因此这里把 1..32 个随机写者操作放进同一个 immediate 事务。
      const burst = Math.min(1 + Math.floor(rand() * 32), events - index);
      const ops: Array<(tx: Transaction) => Promise<void>> = [];
      for (let k = 0; k < burst; k++) {
        const kind = rand();
        if (kind < 0.4) {
          const write = prepareWrite(
            ids[Math.floor(rand() * ids.length)],
            buildInput(Math.floor(rand() * 97)),
          );
          ops.push((tx) => applyWrite(tx, write));
        } else if (kind < 0.85 && poolHashes.length > 0) {
          // 并发写者的写屏障（markReferenced 是唯一实现，GC 必须与之共存）。
          const picks = Array.from(
            { length: 1 + Math.floor(rand() * 3) },
            () => poolHashes[Math.floor(rand() * poolHashes.length)],
          );
          ops.push(async (tx) => {
            await markReferenced(tx, projectId, picks, 0);
          });
        } else {
          // 硬删除根：内容失去引用（后续 sweep 该清掉它）。
          const id = ids[Math.floor(rand() * ids.length)];
          ops.push(async (tx) => {
            await tx.run("DELETE FROM observations WHERE project_id = ? AND id = ?", projectId, id);
            expected.delete(id);
          });
        }
      }
      await clock("writerTx", () =>
        withLocalTransaction(db, async (tx) => {
          for (const op of ops) await op(tx);
        }),
      );
      index += ops.length;
      stats.writerOps += ops.length;
      stats.writerTx += 1;
      if (rand() < 0.05) await refreshPool();
    }
    if (index >= nextCheck) {
      nextCheck = index + 20_000;
      await clock("check", check);
      stats.checks += 1;
      // 长跑卫生（与 GC 语义无关）：本驱动的这套配置不做自动 checkpoint，WAL 会一直涨
      // （实测 1 分钟级写入就把 WAL 顶到 1GB，随后语句逐步变慢直至挂起）。
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    if (index >= nextProgress) {
      nextProgress = index + 100_000;
      console.log(
        `[cas-gc fuzz] progress events=${index} elapsedMs=${Math.round(performance.now() - started)} swaps=${stats.writerTx} gcSteps=${stats.gcSteps}`,
      );
    }
  }
  await check();
  stats.checks += 1;
  // 收尾：连续两轮完整 GC 后，池内容必须恰好等于在用根的引用集合。
  let sweptInTail = 0;
  for (let round = 0; round < 2; round++) {
    for (let stepIndex = 0; stepIndex < 4_096; stepIndex++) {
      const step = await runCasGcStep(db, projectId);
      sweptInTail += step.swept;
      if (step.done) break;
    }
  }
  const poolSize = await assertPoolExactlyReferenced(db, projectId, expected);
  const elapsedMs = performance.now() - started;
  console.log(
    `[cas-gc fuzz] events=${events} elapsedMs=${Math.round(elapsedMs)} eventsPerSec=${Math.round(
      (events / elapsedMs) * 1000,
    )} writerOps=${stats.writerOps} writerTx=${stats.writerTx} gcSteps=${stats.gcSteps} swept=${stats.swept + sweptInTail} checks=${stats.checks} liveRoots=${expected.size} pool=${poolSize}`,
  );
  console.log(
    `[cas-gc fuzz] msByClass writerTx=${Math.round(spent.writerTx)} gcStep=${Math.round(spent.gc)} checks=${Math.round(spent.check)}`,
  );
  console.log(
    `[cas-gc fuzz] maxSingleTxMs writerTx=${maxMs.writerTx.toFixed(1)} gcStep=${maxMs.gc.toFixed(1)}`,
  );
}, 5_400_000);
