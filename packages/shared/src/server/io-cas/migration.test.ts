import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalDatabase, openLocalDatabase } from "../../db/local";
import { decodeIoRow, initializeIoSchema } from "../adapters/io-compression";
import { initializeTelemetrySchema } from "../adapters/sqlite-telemetry-schema";
import {
  applyPlannedRow,
  type CasMigrationOptions,
  planMigrationBatch,
  runCasMigration,
} from "./migration";
import { dryRunCasMigration, rescanResidualRoots, verifyCodecTwoRoots } from "./migration-audit";
import {
  deferred,
  hydrateTx,
  immediate,
  MigrationRowError,
  readMigrationState,
} from "./migration-shared";
import { MigrationStops, RateLimiter } from "./migration-stops";
import { hydrateIoRows } from "./read";

/**
 * W7 回填 / expand 的单测（默认 shared vitest 路径）。
 *
 * 语料是**候选形态**（`messages` 数组、单元素 ≥256B、input ≥16KiB、manifest 更小），
 * 另加一行小 input 作为合法非候选。库用临时目录里的真实引擎文件（与
 * `repositories/*.test.ts` 同一套 `openLocalDatabase` + `initializeTelemetrySchema`），
 * 未改任何全局 env。
 */

const PROJECT = "p1";
const directories: string[] = [];
const databases: LocalDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function newDatabase(): Promise<LocalDatabase> {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-cas-migration-"));
  directories.push(directory);
  const db = await openLocalDatabase(join(directory, "telemetry.db"));
  await initializeTelemetrySchema(db);
  await initializeIoSchema(db);
  databases.push(db);
  return db;
}

/** 确定性伪随机正文：deflate 收益有限，使「跨行去重」而非「逐行压缩」成为主要收益。 */
function variedContent(seed: number, bytes: number): string {
  let state = (seed * 2654435761) >>> 0;
  let text = "";
  while (Buffer.byteLength(text, "utf8") < bytes) {
    state = (state * 1664525 + 1013904223) >>> 0;
    text += "abcdefghijklmnopqrstuvwxyz0123456789"[state % 36];
  }
  return text;
}

/** 候选形态语料：单元素 ≥256B、input ≥16KiB、REF 覆盖率 >50%。 */
function candidate(index: number, elementBytes = 1500): string {
  const messages = Array.from({ length: 12 }, (_, position) => ({
    role: position % 2 === 0 ? "user" : "assistant",
    content: variedContent(index * 100 + position, elementBytes),
  }));
  return JSON.stringify({ messages });
}

/** `rawSize` 对 codec 1 必须是解压后字节数（不是载荷长度）。 */
async function insert(
  db: LocalDatabase,
  id: string,
  input: string | Uint8Array,
  codec: 0 | 1,
  rawSize = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength,
): Promise<void> {
  await db.run(
    `INSERT INTO observations(project_id, id, type, start_time, input, input_codec, input_raw_size, event_ts, updated_at)
     VALUES (?, ?, 'SPAN', '2026-01-01 00:00:00', ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    PROJECT,
    id,
    input,
    codec,
    rawSize,
  );
}

async function run(
  db: LocalDatabase,
  options: Partial<CasMigrationOptions> = {},
): Promise<Awaited<ReturnType<typeof runCasMigration>>> {
  return runCasMigration(db, { projectId: PROJECT, job: "backfill-v1", ...options });
}

async function row(db: LocalDatabase, id: string): Promise<Record<string, unknown>> {
  return (await db.get(
    "SELECT input, input_codec, input_raw_size, event_ts, updated_at FROM observations WHERE project_id=? AND id=?",
    PROJECT,
    id,
  )) as Record<string, unknown>;
}

/** 同事务 hydrate 后读回正文（codec 2 行装配成字符串）。 */
async function readInput(db: LocalDatabase, id: string): Promise<string> {
  const stored = (await db.get(
    "SELECT project_id, input, input_codec, input_raw_size FROM observations WHERE project_id=? AND id=?",
    PROJECT,
    id,
  )) as Record<string, unknown>;
  await deferred(db, async (tx) => {
    await hydrateIoRows(hydrateTx(tx), [stored], { maxBytes: 32 * 1024 * 1024 });
  });
  return String(decodeIoRow(stored).input);
}

async function poolRows(db: LocalDatabase): Promise<number> {
  const counts = (await db.get(
    "SELECT COUNT(*) AS chunks FROM io_cas_chunks WHERE project_id=?",
    PROJECT,
  )) as { chunks?: unknown };
  return Number(counts.chunks ?? 0);
}

describe("回填主流程", () => {
  it("把候选 codec 0/1 行转换为 codec 2 并保持原文逐字节一致", async () => {
    const db = await newDatabase();
    const first = candidate(1);
    const second = candidate(2);
    await insert(db, "a", first, 0);
    await insert(db, "b", second, 0);
    await insert(db, "small", JSON.stringify({ messages: [{ role: "user", content: "x" }] }), 0);

    const report = await run(db, { compress: false });

    expect(report.status).toBe("done");
    expect(report.scanned).toBe(3);
    expect(report.converted).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.cursorId).toBe("small");
    expect(report.verification?.rows).toBe(2);
    expect(report.verification?.errors).toEqual([]);
    expect(report.residual?.candidates).toBe(0);
    expect(report.residual?.nonCandidates).toBe(1);
    expect(await poolRows(db)).toBeGreaterThan(0);

    // 原文逐字节一致 + 三列联动 + 不动 event_ts / updated_at。
    expect(await readInput(db, "a")).toBe(first);
    expect(await readInput(db, "b")).toBe(second);
    const converted = await row(db, "a");
    expect(converted.input_codec).toBe(2);
    expect(Number(converted.input_raw_size)).toBe(Buffer.byteLength(first, "utf8"));
    expect(converted.event_ts).toBe("2026-01-01 00:00:00");
    expect(converted.updated_at).toBe("2026-01-01 00:00:00");
    // 非候选保持原样（仍是 codec 0 的字符串）。
    const untouched = await row(db, "small");
    expect(untouched.input_codec).toBe(0);
    expect(String(untouched.input)).toBe('{"messages":[{"role":"user","content":"x"}]}');
  });

  it("codec 1 行解压后转换，池块按压缩开关落库", async () => {
    const db = await newDatabase();
    const { deflateSync } = await import("node:zlib");
    const text = candidate(7);
    const compressed = deflateSync(Buffer.from(text, "utf8"));
    await insert(db, "z", compressed, 1, Buffer.byteLength(text, "utf8"));

    const report = await run(db, { compress: true });
    expect(report.status).toBe("done");
    expect(report.converted).toBe(1);
    expect(await readInput(db, "z")).toBe(text);
    const chunk = (await db.get(
      "SELECT codec, raw_size FROM io_cas_chunks WHERE project_id=? LIMIT 1",
      PROJECT,
    )) as { codec: number; raw_size: number };
    expect([0, 1]).toContain(Number(chunk.codec));
    expect(Number(chunk.raw_size)).toBeGreaterThan(0);
  });
});

describe("写事务内的并发核对（无更新覆盖）", () => {
  it("旧三列不一致时跳过，绝不覆盖并发写者的值", async () => {
    const db = await newDatabase();
    const original = candidate(3);
    await insert(db, "a", original, 0);
    const planned = await planMigrationBatch(db, { projectId: PROJECT, job: "backfill-v1" }, null);
    expect(planned).toHaveLength(1);
    expect(planned[0].cas).toBeDefined();

    const concurrent = candidate(99);
    await db.run(
      "UPDATE observations SET input=?, input_raw_size=? WHERE project_id=? AND id=?",
      concurrent,
      Buffer.byteLength(concurrent, "utf8"),
      PROJECT,
      "a",
    );

    let outcome: string | undefined;
    await immediate(db, async (tx) => {
      outcome = await applyPlannedRow(
        tx,
        { projectId: PROJECT, job: "backfill-v1", compress: false },
        planned[0],
      );
    });
    expect(outcome).toBe("skipped");
    const after = await row(db, "a");
    expect(after.input_codec).toBe(0);
    expect(String(after.input)).toBe(concurrent);
  });

  it("计划后行被删除时跳过而不是复活该行", async () => {
    const db = await newDatabase();
    await insert(db, "a", candidate(4), 0);
    const planned = await planMigrationBatch(db, { projectId: PROJECT, job: "backfill-v1" }, null);
    await db.run("DELETE FROM observations WHERE project_id=? AND id=?", PROJECT, "a");
    let outcome: string | undefined;
    await immediate(db, async (tx) => {
      outcome = await applyPlannedRow(
        tx,
        { projectId: PROJECT, job: "backfill-v1", compress: false },
        planned[0],
      );
    });
    expect(outcome).toBe("skipped");
    expect(
      await db.get("SELECT 1 FROM observations WHERE project_id=? AND id=?", PROJECT, "a"),
    ).toBeUndefined();
  });
});

describe("暂停与续跑", () => {
  it("显式暂停后从已提交游标续跑，且不重复转换", async () => {
    const db = await newDatabase();
    await insert(db, "a", candidate(1), 0);
    await insert(db, "b", candidate(2), 0);
    await insert(db, "c", candidate(3), 0);

    let paused = false;
    const first = await run(db, {
      batchRows: 1,
      verify: false,
      stops: { pauseRequested: () => paused },
      onProgress: () => {
        paused = true;
      },
    });
    expect(first.status).toBe("paused");
    expect(first.reason).toBe("pause-requested");
    expect(first.cursorId).toBe("a");
    expect(first.converted).toBe(1);
    expect((await readMigrationState(db, PROJECT, "backfill-v1"))?.status).toBe("paused");

    const resumed = await run(db, { batchRows: 1, resume: true });
    expect(resumed.status).toBe("done");
    // 计数是 pass 级累计值：回填前的 1 + 续跑后的 2。
    expect(resumed.converted).toBe(3);
    expect(resumed.cursorId).toBe("c");
    expect((await row(db, "a")).input_codec).toBe(2);
    expect(await readInput(db, "c")).toBe(candidate(3));
    expect(await poolRows(db)).toBeGreaterThan(0);
  });

  it("未完成状态未加 --resume 时拒绝启动；pass 到期后可用新 pass 重跑", async () => {
    const db = await newDatabase();
    await insert(db, "a", candidate(1), 0);
    const done = await run(db, {});
    expect(done.status).toBe("done");
    await expect(run(db, {})).rejects.toThrow("IO_CAS_MIGRATION_DONE");
    const second = await run(db, { pass: 2 });
    expect(second.status).toBe("done");
    expect(second.pass).toBe(2);
    // 新 pass 从游标起点重扫：此时已无 codec 0/1 候选行。
    expect(second.scanned).toBe(0);
    await expect(run(db, { resume: true, pass: 3 })).rejects.toThrow("IO_CAS_MIGRATION_PASS");
  });
});

describe("损坏与失败分类", () => {
  it("codec 1 载荷不可解压时记 failed 并暂停，游标不前移", async () => {
    const db = await newDatabase();
    await insert(db, "a", candidate(1), 0);
    await insert(db, "bad", Buffer.from("not deflate at all", "utf8"), 1);

    const report = await run(db, { batchRows: 1 });
    expect(report.status).toBe("failed");
    expect(report.lastError).toContain("IO_COMPRESSION_CORRUPT@bad");
    const state = await readMigrationState(db, PROJECT, "backfill-v1");
    expect(state?.status).toBe("failed");
    expect(state?.cursorId).toBe("a");
    // 坏行未被改动。
    expect((await row(db, "bad")).input_codec).toBe(1);
  });

  it("池内容被篡改时 expand 报 IO_CAS_CORRUPT（不静默替换）", async () => {
    const db = await newDatabase();
    await insert(db, "a", candidate(5), 0);
    expect((await run(db, {})).status).toBe("done");
    await db.run(
      "UPDATE io_cas_chunks SET payload=? WHERE project_id=? AND rowid=(SELECT rowid FROM io_cas_chunks WHERE project_id=? LIMIT 1)",
      Buffer.from("tampered", "utf8"),
      PROJECT,
      PROJECT,
    );
    const expand = await runCasMigration(db, { projectId: PROJECT, job: "expand-v1" });
    expect(expand.status).toBe("failed");
    expect(expand.lastError).toMatch(/IO_CAS_(CORRUPT|MISSING)@a/);
    expect((await row(db, "a")).input_codec).toBe(2);
  });
});

describe("expand 回退", () => {
  it("codec 2 归零且原文与回填前逐字节一致", async () => {
    const db = await newDatabase();
    const inputs = [candidate(1), candidate(2)];
    await insert(db, "a", inputs[0], 0);
    await insert(db, "b", inputs[1], 0);
    expect((await run(db, {})).status).toBe("done");

    const report = await runCasMigration(db, {
      projectId: PROJECT,
      job: "expand-v1",
      compress: true,
    });
    expect(report.status).toBe("done");
    expect(report.converted).toBe(2);
    expect(report.codecTwoRows).toBe(0);
    for (const [id, text] of [
      ["a", inputs[0]],
      ["b", inputs[1]],
    ] as const) {
      const stored = await row(db, id);
      expect([0, 1]).toContain(Number(stored.input_codec));
      expect(await readInput(db, id)).toBe(text);
      expect(Number(stored.input_raw_size)).toBe(Buffer.byteLength(text, "utf8"));
    }
    expect(report.verification).toBeUndefined();
  });

  it("扫描开始后新写入的 codec 2 行（游标之前）让收尾校验失败", async () => {
    const db = await newDatabase();
    await insert(db, "b", candidate(6), 0);
    await insert(db, "c", candidate(7), 0);
    expect((await run(db, {})).status).toBe("done");
    const manifest = (await db.get(
      "SELECT input, input_raw_size FROM observations WHERE project_id=? AND id='b'",
      PROJECT,
    )) as { input: Uint8Array; input_raw_size: number };

    const report = await runCasMigration(db, {
      projectId: PROJECT,
      job: "expand-v1",
      batchRows: 1,
      onProgress: async (progress) => {
        if (progress.batches > 1 || progress.cursorId !== "b") return;
        // 未停止的 CAS 写者：在游标**之前**插入新的 codec 2 行，expand 不会再看到它。
        await db.run(
          `INSERT INTO observations(project_id, id, type, start_time, input, input_codec, input_raw_size)
           VALUES (?, 'a', 'SPAN', '2026-01-01 00:00:00', ?, 2, ?)`,
          PROJECT,
          manifest.input,
          manifest.input_raw_size,
        );
      },
    });
    expect(report.status).toBe("failed");
    expect(report.codecTwoRows).toBe(1);
    expect(report.reason).toBe("IO_CAS_RESIDUAL_CODEC2");
  });
});

describe("审计面", () => {
  it("残余重扫把候选与非候选分开计数，校验遍历全部 codec 2 根", async () => {
    const db = await newDatabase();
    await insert(db, "a", candidate(1), 0);
    await insert(db, "small", JSON.stringify({ messages: [{ role: "user", content: "x" }] }), 0);
    expect((await run(db, {})).status).toBe("done");

    const residual = await rescanResidualRoots(db, { projectId: PROJECT });
    expect(residual.candidates).toBe(0);
    expect(residual.nonCandidates).toBe(1);
    expect(residual.scanned).toBe(1);

    const verification = await verifyCodecTwoRoots(db, { projectId: PROJECT });
    expect(verification.rows).toBe(1);
    expect(verification.refs).toBeGreaterThan(0);
    expect(verification.uniqueRefs).toBeGreaterThan(0);
    expect(verification.errors).toEqual([]);
  });

  it("dry-run 用字节口径给出覆盖率 / 唯一率 / codec 1 基线", async () => {
    const db = await newDatabase();
    const text = candidate(8);
    await insert(db, "a", text, 0);
    await insert(db, "b", text, 0);

    const report = await dryRunCasMigration(db, { projectId: PROJECT, compress: true });
    expect(report.sampledRows).toBe(2);
    expect(report.projectRows).toBe(2);
    expect(report.extrapolated).toBe(false);
    expect(report.candidateRows).toBe(2);
    // 切片计划是原文的完整划分：literal + ref 字节 == 候选原文字节。
    expect(report.literalBytes + report.refBytes).toBe(report.candidateBytes);
    expect(report.uniqueRefBytes).toBeLessThanOrEqual(report.refBytes);
    expect(report.uniqueRefBytes).toBeGreaterThan(0);
    expect(report.manifestBytes).toBeGreaterThan(0);
    expect(report.projectedStoredBytes).toBe(report.manifestBytes + report.poolStoredBytes);
    // 完全重复的两行：池块只计一次，投影必然小于逐行压缩基线。
    expect(report.projectedStoredBytes).toBeLessThan(report.baselineStoredBytes);
  });
});

describe("停止条件", () => {
  const covered = { windowMs: 1000, minSamples: 3, now: () => 10_000 };

  it("pause / 磁盘预留优先判定", () => {
    const paused = new MigrationStops({ ...covered, pauseRequested: () => true });
    expect(paused.reason()).toBe("pause-requested");
    const disk = new MigrationStops({ ...covered, diskFreeBytes: () => 10, diskReserveBytes: 100 });
    expect(disk.reason()).toBe("disk-reserve");
  });

  it("写锁等待 p95 超阈值且窗口覆盖 60s 才暂停", () => {
    let now = 0;
    const stops = new MigrationStops({ windowMs: 60_000, minSamples: 3, now: () => now });
    // 窗口从 t=0 覆盖到 t=60s（样本跨度 ≥ windowMs）才判定。
    stops.record({ lockWaitMs: 80 });
    for (let index = 0; index < 3; index++) {
      now += 20_000;
      stops.record({ lockWaitMs: 80 });
    }
    expect(stops.reason()).toBe("lock-wait-p95");

    const notCovered = new MigrationStops({ windowMs: 60_000, minSamples: 3, now: () => now });
    now += 10;
    notCovered.record({ lockWaitMs: 999 });
    expect(notCovered.reason()).toBeUndefined();
  });

  it("业务 p95 用首个完整窗口自校准，恶化超过 20% 才暂停", () => {
    let now = 0;
    const stops = new MigrationStops({ windowMs: 60_000, minSamples: 3, now: () => now });
    stops.record({ businessMs: 10 });
    for (let index = 0; index < 3; index++) {
      now += 20_000;
      stops.record({ businessMs: 10 });
    }
    expect(stops.reason()).toBeUndefined();
    expect(stops.businessBaselineMs).toBe(10);
    now += 60_001;
    stops.record({ businessMs: 13 });
    for (let index = 0; index < 3; index++) {
      now += 20_000;
      stops.record({ businessMs: 13 });
    }
    expect(stops.reason()).toBe("business-p95");
  });

  it("速率上限按累积平均压制（5MiB/s 口径）", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const limiter = new RateLimiter(
      5 * 1024 * 1024,
      () => now,
      async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    );
    // 2MiB 在 5MiB/s 下需要 400ms，累积口径一次性补齐。
    await limiter.pace(2 * 1024 * 1024);
    expect(sleeps).toEqual([400]);
    // 再 8MiB：总量 10MiB → 目标 2000ms，已流逝 400ms。
    await limiter.pace(8 * 1024 * 1024);
    expect(sleeps[1]).toBeCloseTo(1600, 5);
  });
});

describe("失败分类", () => {
  it("MigrationRowError 携带 id 且错误码来自 message", () => {
    const error = new MigrationRowError("obs-1", "IO_CAS_CORRUPT");
    expect(error.rowId).toBe("obs-1");
    expect(error.code).toBe("IO_CAS_CORRUPT");
  });
});
