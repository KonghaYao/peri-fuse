/**
 * W7 验收：回填 / expand 的在线并发写、暂停续跑、空间回退（可放大的合成语料）。
 *
 * 语料结构与设计 §2 的样本同形：每行是 40 条消息的 JSON 数组，相邻行共享 39 条
 * 消息（`slice(i, i+40)`，跨行去重率 ≈97%），消息正文是确定性伪随机文本，使
 * deflate 收益有限——收益主要来自跨行去重而非逐行压缩。规模用环境变量放大：
 * `CAS_BENCH_ROWS`（默认 900）、`CAS_BENCH_MESSAGES`（40）、`CAS_BENCH_ELEMENT_BYTES`（6000）。
 *
 * 步骤（每步都打印原始数据，报告直接引用）：
 *   1. 预置 codec 1 语料 → `--dry-run` 统计；
 *   2. 启动在线写者（CAS 写开启，新增 + 覆盖既有行），跑到 SIGKILL 杀迁移进程；
 *   3. `--resume` 重跑 → SIGINT 优雅暂停 → 再 `--resume` 跑到完成；
 *   4. 逐行 hydrate 校验「无更新覆盖」（期望内容 hash 全部一致）；
 *   5. 停止写者 → expand-v1 → 校验 codec 2 = 0 且原文逐字节一致。
 *
 * Usage:
 *   cd packages/shared
 *   pnpm --filter @peri-fuse/shared run build   # 管理命令按 dist 运行
 *   PERIFUSE_ENGINE=sqlite bun run scripts/cas-migration-bench.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PERIFUSE_ENGINE = "sqlite";
process.env.LANGFUSE_MODE ??= "lite";
process.env.PERIFUSE_READ_WORKERS = "0";
process.env.PERIFUSE_IO_COMPRESSION_WRITE = "on";
assert.equal(typeof process.versions.bun, "string", "This bench requires the Bun runtime");

const { SQLiteTelemetryAdapter } = await import("../src/server/adapters/sqlite-telemetry-adapter");
const { decodeIoRow } = await import("../src/server/adapters/io-compression");
const { withLocalTransaction } = await import("../src/db/local");
const { hydrateIoRows } = await import("../src/server/io-cas/read");

const PROJECT = "bench";
const ROWS = Number(process.env.CAS_BENCH_ROWS ?? 900);
const MESSAGES = Number(process.env.CAS_BENCH_MESSAGES ?? 40);
const ELEMENT_BYTES = Number(process.env.CAS_BENCH_ELEMENT_BYTES ?? 6000);
const WRITER_INTERVAL_MS = Number(process.env.CAS_BENCH_WRITER_MS ?? 200);
const MAX_WRITES = Number(process.env.CAS_BENCH_MAX_WRITES ?? 400);
/** 回填段的请求速率（默认 5 = 设计初始上限）；expand 段不受该上限约束。 */
const RATE_MIB = Number(process.env.CAS_BENCH_RATE_MIB ?? 5);

const root = mkdtempSync(join(tmpdir(), "perifuse-cas-migration-bench-"));
const dbPath = join(root, "telemetry.db");
const logDirectory = join(root, "logs");
mkdirSync(logDirectory, { recursive: true });
const migrateScript = new URL("../../../scripts/cas-migrate.mjs", import.meta.url).pathname;
const childEnv = {
  ...process.env,
  PERIFUSE_ENGINE: "sqlite",
  LANGFUSE_MODE: "lite",
  TURSO_TELEMETRY_DATABASE_URL: dbPath,
  PERIFUSE_IO_COMPRESSION_WRITE: "on",
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function variedContent(seed: number, bytes: number): string {
  let state = (seed * 2654435761) >>> 0;
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const chunk = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[state % 62];
    parts.push(chunk);
    length++;
  }
  return parts.join("");
}

/** 消息池：行 i 使用 pool[i .. i+MESSAGES)，相邻行只差一条消息。 */
const pool = Array.from({ length: ROWS + MESSAGES + 4 * MAX_WRITES }, (_, index) =>
  variedContent(index + 1, ELEMENT_BYTES),
);
function rowText(start: number): string {
  return JSON.stringify({
    messages: Array.from({ length: MESSAGES }, (_, offset) => ({
      role: offset % 2 === 0 ? "user" : "assistant",
      content: pool[start + offset],
    })),
  });
}

function openSyncLog(name: string): { fd: number; path: string } {
  const path = join(logDirectory, name);
  return { fd: openSync(path, "w"), path };
}

let runSeq = 0;
async function runChild(
  args: string[],
  options: { waitMs?: number; signal?: "SIGINT" | "SIGKILL" } = {},
): Promise<{ code: number; stdout: string; stderr: string; interrupted?: string }> {
  const out = openSyncLog(`migrate-${runSeq}.out`);
  const err = openSyncLog(`migrate-${runSeq}.err`);
  runSeq++;
  const proc = Bun.spawn(["bun", migrateScript, ...args], {
    env: childEnv,
    stdout: out.fd,
    stderr: err.fd,
  });
  let interrupted: string | undefined;
  if (options.waitMs !== undefined) {
    await Bun.sleep(options.waitMs);
    if (proc.exitCode === null) {
      interrupted = options.signal ?? "SIGKILL";
      proc.kill(interrupted as never);
    }
  }
  const code = await proc.exited;
  closeSync(out.fd);
  closeSync(err.fd);
  return { code, stdout: readFileSync(out.path, "utf8"), stderr: readFileSync(err.path, "utf8") };
}

function parseReport(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  assert.ok(start >= 0, `migration printed no report: ${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

function databaseBytes(): number {
  const base = statSync(dbPath).size;
  const wal = (() => {
    try {
      return statSync(`${dbPath}-wal`).size;
    } catch {
      return 0;
    }
  })();
  return base + wal;
}

/** 逐行 hydrate 并与期望内容 hash 比对（无更新覆盖的直接证据）。 */
async function verifyAll(
  adapter: SQLiteTelemetryAdapter,
  expected: Map<string, string>,
): Promise<{ checked: number; mismatches: string[]; codecTwo: number; bytes: number }> {
  const db = adapter.getDatabase();
  const mismatches: string[] = [];
  let checked = 0;
  let bytes = 0;
  let cursor = "";
  for (;;) {
    const ids = (await db.all(
      "SELECT id FROM observations WHERE project_id=? AND id>? ORDER BY id LIMIT 24",
      PROJECT,
      cursor,
    )) as { id: string }[];
    if (ids.length === 0) break;
    cursor = String(ids[ids.length - 1].id);
    const rows = (await db.all(
      `SELECT project_id, id, input, input_codec, input_raw_size FROM observations
       WHERE project_id=? AND id>=? AND id<=? ORDER BY id`,
      PROJECT,
      String(ids[0].id),
      cursor,
    )) as Record<string, unknown>[];
    await withLocalTransaction(db, async (tx) => {
      await hydrateIoRows(tx, rows, { maxBytes: 64 * 1024 * 1024 });
    });
    for (const row of rows) {
      checked++;
      // 与真实读路径一致：codec 2 已由 hydrate 装配，codec 0/1 交给 decodeIoRow。
      const text = String(decodeIoRow(row).input);
      bytes += Buffer.byteLength(text, "utf8");
      if (expected.get(String(row.id)) !== sha256(text)) mismatches.push(String(row.id));
    }
  }
  const counts = (await db.get(
    "SELECT COUNT(*) AS count FROM observations WHERE project_id=? AND input_codec=2",
    PROJECT,
  )) as { count: number };
  return { checked, mismatches: mismatches.slice(0, 10), codecTwo: Number(counts.count), bytes };
}

async function main(): Promise<void> {
  const started = performance.now();
  // 预置阶段：CAS 写关闭（历史存量数据是 codec 0/1）。
  process.env.PERIFUSE_IO_CAS_WRITE = "off";
  const adapter = new SQLiteTelemetryAdapter(dbPath);
  await adapter.initialize();
  const expected = new Map<string, string>();
  const seedIds: string[] = [];

  const seedStarted = performance.now();
  for (let index = 0; index < ROWS; index++) {
    const id = `obs-${String(index).padStart(6, "0")}`;
    const text = rowText(index);
    seedIds.push(id);
    expected.set(id, sha256(text));
    await adapter.insert({
      table: "observations",
      records: [
        {
          project_id: PROJECT,
          id,
          trace_id: "t",
          start_time: "2026-01-01 00:00:00",
          input: text,
          output: "",
        },
      ],
    });
  }
  const seed = {
    rows: ROWS,
    messagesPerRow: MESSAGES,
    elementBytes: ELEMENT_BYTES,
    seedMs: Math.round(performance.now() - seedStarted),
    databaseBytes: databaseBytes(),
  };
  console.log(`[bench] seed ${JSON.stringify(seed)}`);

  const dry = parseReport((await runChild(["--project", PROJECT, "--dry-run"])).stdout);
  console.log(
    `[bench] dry-run ${JSON.stringify({
      projectRows: dry.projectRows,
      totalBytes: dry.totalBytes,
      candidateRows: dry.candidateRows,
      candidateBytes: dry.candidateBytes,
      refBytes: dry.refBytes,
      uniqueRefBytes: dry.uniqueRefBytes,
      uniqueChunks: dry.uniqueChunks,
      manifestBytes: dry.manifestBytes,
      poolStoredBytes: dry.poolStoredBytes,
      projectedStoredBytes: dry.projectedStoredBytes,
      baselineStoredBytes: dry.baselineStoredBytes,
      estimatedRootIndexBytes: dry.estimatedRootIndexBytes,
    })}`,
  );

  // 在线写者：CAS 写开启（M3 灰度后的目标状态），新增行 + 覆盖既有行。
  process.env.PERIFUSE_IO_CAS_WRITE = "on";
  const writer = new SQLiteTelemetryAdapter(dbPath);
  await writer.initialize();
  let stopWrites = false;
  let writes = 0;
  let updates = 0;
  const writerTask = (async () => {
    while (!stopWrites && writes < MAX_WRITES) {
      const id = `w-${String(writes).padStart(6, "0")}`;
      const text = rowText(ROWS + writes * 2);
      writes++;
      await writer.insert({
        table: "observations",
        records: [
          {
            project_id: PROJECT,
            id,
            trace_id: "t",
            start_time: "2026-01-01 00:00:01",
            input: text,
            output: "",
          },
        ],
      });
      expected.set(id, sha256(text));
      const target = seedIds[(updates * 7) % seedIds.length];
      const updated = rowText(ROWS + MAX_WRITES * 2 + updates);
      updates++;
      await writer.insert({
        table: "observations",
        records: [
          {
            project_id: PROJECT,
            id: target,
            trace_id: "t",
            start_time: "2026-01-01 00:00:02",
            input: updated,
            output: "",
          },
        ],
      });
      expected.set(target, sha256(updated));
      await Bun.sleep(WRITER_INTERVAL_MS);
    }
  })();

  // 1) 跑到中途杀进程（SIGKILL：模拟崩溃，无优雅收尾）。
  const killed = await runChild(["--project", PROJECT, "--rate-mib", String(RATE_MIB)], {
    waitMs: Number(process.env.CAS_BENCH_KILL_MS ?? 4000),
    signal: "SIGKILL",
  });
  const afterKill = await adapter
    .getDatabase()
    .get(
      "SELECT status, cursor_id, scanned, converted FROM io_cas_migration_state WHERE project_id=? AND job='backfill-v1'",
      PROJECT,
    );
  console.log(
    `[bench] after SIGKILL ${JSON.stringify({ exitCode: killed.code, state: afterKill, writes, updates })}`,
  );

  // 2) 续跑 → SIGINT 优雅暂停。
  const paused = await runChild(
    ["--project", PROJECT, "--resume", "--rate-mib", String(RATE_MIB)],
    {
      waitMs: Number(process.env.CAS_BENCH_PAUSE_MS ?? 4000),
      signal: "SIGINT",
    },
  );
  console.log(
    `[bench] after SIGINT ${JSON.stringify({ exitCode: paused.code, state: JSON.parse(paused.stdout || "{}") })}`,
  );

  // 3) 跑到完成。
  const first = parseReport(
    (await runChild(["--project", PROJECT, "--resume", "--rate-mib", String(RATE_MIB)])).stdout,
  );
  console.log(`[bench] backfill-report ${JSON.stringify(first)}`);

  stopWrites = true;
  await writerTask;
  console.log(`[bench] writer stopped ${JSON.stringify({ writes, updates })}`);

  const beforeExpand = await verifyAll(adapter, expected);
  console.log(`[bench] verify-after-backfill ${JSON.stringify(beforeExpand)}`);
  const databaseAfterBackfill = databaseBytes();

  // 4) expand-v1（写者已停止）→ codec 2 归零 + 原文逐字节一致。
  const expandReport = parseReport(
    (
      await runChild([
        "--project",
        PROJECT,
        "--job",
        "expand-v1",
        "--acknowledge-writers-stopped",
        "--rate-mib",
        "40",
      ])
    ).stdout,
  );
  console.log(`[bench] expand-report ${JSON.stringify(expandReport)}`);
  const afterExpand = await verifyAll(adapter, expected);
  console.log(`[bench] verify-after-expand ${JSON.stringify(afterExpand)}`);

  // 5) 空间基线：再跑一轮回填（pass 2，expand 已把行退回 codec 0/1），观察池规模。
  const secondBackfill = parseReport(
    (await runChild(["--project", PROJECT, "--pass", "2", "--rate-mib", "40"])).stdout,
  );
  const final = await adapter.getDatabase().get(
    `SELECT COUNT(*) AS rows,
       SUM(CASE WHEN input_codec=2 THEN 1 ELSE 0 END) AS codecTwo,
       SUM(CASE WHEN input_codec IN (0,1) THEN 1 ELSE 0 END) AS codecZeroOne
     FROM observations WHERE project_id=?`,
    PROJECT,
  );
  const pool = await adapter
    .getDatabase()
    .get(
      "SELECT COUNT(*) AS chunks, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM io_cas_chunks WHERE project_id=?",
      PROJECT,
    );

  console.log(
    `[bench] summary ${JSON.stringify(
      {
        seed,
        killResume: { killedExit: killed.code, pausedExit: paused.code },
        backfill: first,
        expand: expandReport,
        secondBackfill,
        verifyAfterBackfill: beforeExpand,
        verifyAfterExpand: afterExpand,
        finalRows: final,
        pool,
        databaseAfterBackfill,
        databaseBytes: databaseBytes(),
        wallMs: Math.round(performance.now() - started),
        cleanup: root,
      },
      null,
      2,
    )}`,
  );
  await writer.close();
  await adapter.close();
  if (process.env.CAS_BENCH_KEEP !== "1") rmSync(root, { recursive: true, force: true });
}

await main();
