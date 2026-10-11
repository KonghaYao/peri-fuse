/**
 * Bun bench: CAS 写入的准备/锁开销与 WAL 写字节对比（W5 验收「大重复写」「准备与锁」「小请求」）。
 *
 * 方法（每步都打印原始数据，报告直接引用）：
 *   1. 纯准备：对同一个 ~500KiB messages input 直接调用 `prepareCasInput` N 次，取 p50/p95。
 *   2. 写事务持锁：单条 ~500KiB CAS 记录 `adapter.insert` 端到端 p50/p95；再减去同一输入的
 *      纯准备耗时（估计值：同一次调用里「纯准备（锁外）+ 事务（锁内）」两段）。
 *   3. WAL 写字节：两个全新库写同一批数据——40 行 x 32 条消息，每行只新增 2 条消息
 *      （去重率 ~91%，对应设计 §2 的 94.3% 样本结构）。正文用确定性伪随机文本，
 *      deflate 收益有限，因此对比是「逐行 deflate」vs「跨行去重 + deflate」。
 *      批前 `PRAGMA wal_autocheckpoint=0`，批次结束后读 `-wal` 文件字节数（不会被自动截断）。
 *   4. 小请求：~2KiB 正文各写 300 次，CAS on 与 off 的 p50/p95 与差值。
 *
 * Usage:
 *   cd packages/shared
 *   PERIFUSE_ENGINE=sqlite bun run scripts/cas-write-bench.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LANGFUSE_MODE ??= "lite";
process.env.PERIFUSE_ENGINE = "sqlite";
process.env.PERIFUSE_IO_COMPRESSION_WRITE = "on";
process.env.PERIFUSE_READ_WORKERS = "0";

assert.equal(typeof process.versions.bun, "string", "This bench requires the Bun runtime");

const { SQLiteTelemetryAdapter } = await import("../src/server/adapters/sqlite-telemetry-adapter");
const { prepareCasInput } = await import("../src/server/io-cas/prepare");

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** 确定性伪随机正文：deflate 收益有限，避免用「重复字符」把基线压成不真实的极小值。 */
function variedContent(seed: number, bytes: number): string {
  let state = (seed * 2654435761) >>> 0;
  let text = "";
  while (Buffer.byteLength(text, "utf8") < bytes) {
    state = (state * 1664525 + 1013904223) >>> 0;
    text += "abcdefghijklmnopqrstuvwxyz0123456789中文观测"[state % 43];
  }
  return text;
}

async function adapterFor(path: string, cas: "on" | "off") {
  process.env.PERIFUSE_IO_CAS_WRITE = cas;
  const adapter = new SQLiteTelemetryAdapter(path);
  await adapter.initialize();
  return adapter;
}

function walBytes(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

function record(id: string, input: string, eventTs: string) {
  return {
    project_id: "p",
    id,
    trace_id: "t",
    start_time: "2026-01-01 00:00:00",
    input,
    event_ts: eventTs,
    updated_at: eventTs,
  };
}

/**
 * 包裹 `db.transactionAsync(...).immediate()`，把每次事务的完整时长记入 `samples`。
 * 只测量、不改变调用形状（`immediate` 仍返回 Promise）。
 */
function instrumentTransactionLock(adapter: { getDatabase(): unknown }): number[] {
  const samples: number[] = [];
  const db = adapter.getDatabase() as {
    transactionAsync: (...args: unknown[]) => {
      immediate: (...args: unknown[]) => Promise<unknown>;
    };
  };
  const original = db.transactionAsync.bind(db);
  db.transactionAsync = (...args: unknown[]) => {
    const chain = original(...args);
    const immediate = chain.immediate.bind(chain);
    chain.immediate = (...callArgs: unknown[]) => {
      const start = performance.now();
      return immediate(...callArgs).then(
        (value) => {
          samples.push(performance.now() - start);
          return value;
        },
        (error) => {
          samples.push(performance.now() - start);
          throw error;
        },
      );
    };
    return chain;
  };
  return samples;
}

const directory = mkdtempSync(join(tmpdir(), "perifuse-cas-write-bench-"));
const big = JSON.stringify({
  messages: Array.from({ length: 48 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: variedContent(index + 1, 10 * 1024),
  })),
});
const small = JSON.stringify({
  messages: [{ role: "user", content: variedContent(7, 1024) }],
});
console.log(
  `payload: big=${Buffer.byteLength(big, "utf8")}B small=${Buffer.byteLength(small, "utf8")}B`,
);
try {
  // 1) 纯准备 p50/p95
  const prepareMs: number[] = [];
  for (let index = 0; index < 50; index++) {
    const start = performance.now();
    assert.ok(prepareCasInput(big, { projectId: "p" }), "big input must be a CAS candidate");
    prepareMs.push(performance.now() - start);
  }
  console.log(
    `prepare(${Buffer.byteLength(big, "utf8")}B): p50=${percentile(prepareMs, 0.5).toFixed(2)}ms p95=${percentile(prepareMs, 0.95).toFixed(2)}ms`,
  );
  const prepareNoDeflate: number[] = [];
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    prepareCasInput(big, { projectId: "p", compress: false });
    prepareNoDeflate.push(performance.now() - start);
  }
  console.log(
    `prepare(compress=off): p50=${percentile(prepareNoDeflate, 0.5).toFixed(2)}ms p95=${percentile(prepareNoDeflate, 0.95).toFixed(2)}ms`,
  );

  // 2) 写事务持锁：直接测量 `transactionAsync(...).immediate()` 的完整时长
  //    （含 FIFO gate 等待、BEGIN IMMEDIATE、语句执行、COMMIT）。
  //    关闭 auto-checkpoint：4MB WAL 合并回主库的 fsync 尖峰（本机实测 40–110ms）
  //    会周期性混入样本，与写路径无关；checkpoint 的真实成本见报告。
  const writeAdapter = await adapterFor(join(directory, "write.db"), "on");
  await writeAdapter.getDatabase().exec("PRAGMA wal_autocheckpoint=0");
  const lockSamples = instrumentTransactionLock(writeAdapter);
  const measure = async (iterations: number, inputFor: (index: number) => string, prefix = "w") => {
    const totals: number[] = [];
    const locks: number[] = [];
    for (let index = 0; index < iterations; index++) {
      const input = inputFor(index);
      assert.ok(prepareCasInput(input, { projectId: "p" }), "candidate expected");
      const first = lockSamples.length;
      const start = performance.now();
      await writeAdapter.insert({
        table: "observations",
        records: [
          record(
            `${prefix}-${index}`,
            input,
            `2099-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
          ),
        ],
      });
      totals.push(performance.now() - start);
      // 一次 insert = 一个事务；求和防御后续若拆成多个事务。
      locks.push(lockSamples.slice(first).reduce((sum, value) => sum + value, 0));
    }
    return { totals, locks };
  };
  const freshInput = (index: number) =>
    JSON.stringify({
      messages: Array.from({ length: 48 }, (_, position) => ({
        role: position % 2 === 0 ? "user" : "assistant",
        content: variedContent(index * 100 + position + 1, 10 * 1024),
      })),
    });
  // 预热（丢弃）：JIT、WAL 首次增长与页缓存稳定后再采样，避免把冷启动算进 p95。
  for (let index = 0; index < 5; index++)
    await writeAdapter.insert({
      table: "observations",
      records: [record(`warmup-${index}`, freshInput(index + 10_000), "2099-01-01T01:00:00Z")],
    });
  lockSamples.length = 0;
  const fresh = await measure(60, freshInput, "f");
  console.log(
    `insert(fresh 500KiB, CAS on): p50=${percentile(fresh.totals, 0.5).toFixed(2)}ms p95=${percentile(fresh.totals, 0.95).toFixed(2)}ms`,
  );
  console.log(
    `write-lock fresh(+pool publish, 48 new chunks): p50=${percentile(fresh.locks, 0.5).toFixed(2)}ms p95=${percentile(fresh.locks, 0.95).toFixed(2)}ms`,
  );
  lockSamples.length = 0;
  const warm = await measure(120, () => big, "warm");
  console.log(
    `write-lock warm(pool already hashed): p50=${percentile(warm.locks, 0.5).toFixed(2)}ms p95=${percentile(warm.locks, 0.95).toFixed(2)}ms`,
  );
  // 2b) 稳态混写：等价设计 §2 的 94.3% 消息级去重率——首写建立 30 条共享消息，
  //     之后每条 input 只新增 2 条消息（2/32 ≈ 6% 新内容）。
  const shared = Array.from({ length: 30 }, (_, position) => ({
    role: position % 2 === 0 ? "user" : "assistant",
    content: variedContent(50_000 + position, 10 * 1024),
  }));
  const steadyInput = (index: number) =>
    JSON.stringify({
      messages: [
        ...shared,
        { role: "user", content: variedContent(900_000 + index * 2, 10 * 1024) },
        { role: "assistant", content: variedContent(900_001 + index * 2, 10 * 1024) },
      ],
    });
  await writeAdapter.insert({
    table: "observations",
    records: [record("steady-0", steadyInput(0), "2099-01-02T00:00:00Z")],
  });
  lockSamples.length = 0;
  const steady = await measure(120, (index) => steadyInput(index + 1), "s");
  console.log(
    `write-lock steady(~94% dedup, +2 chunks): p50=${percentile(steady.locks, 0.5).toFixed(2)}ms p95=${percentile(steady.locks, 0.95).toFixed(2)}ms`,
  );
  await writeAdapter.close();

  // 2c) 对照：CAS off（既有 codec 1 路径）写同样大小的 500KiB 唯一正文。
  //     两方案都必须把 ~480KiB 级内容写进 WAL，用于判定 25ms 目标的物理可达性。
  const plainAdapter = await adapterFor(join(directory, "write-plain.db"), "off");
  await plainAdapter.getDatabase().exec("PRAGMA wal_autocheckpoint=0");
  const plainSamples = instrumentTransactionLock(plainAdapter);
  const plainLocks: number[] = [];
  for (let index = 0; index < 60; index++) {
    const first = plainSamples.length;
    await plainAdapter.insert({
      table: "observations",
      records: [record(`p-${index}`, freshInput(index + 5000), "2099-01-03T00:00:00Z")],
    });
    plainLocks.push(plainSamples.slice(first).reduce((sum, value) => sum + value, 0));
  }
  console.log(
    `write-lock fresh 500KiB(cas off, codec 1): p50=${percentile(plainLocks, 0.5).toFixed(2)}ms p95=${percentile(plainLocks, 0.95).toFixed(2)}ms`,
  );
  await plainAdapter.close();

  // 3) WAL 写字节：40 行 x 32 条消息，每行新增 2 条（去重率 ~91%）
  const rows = 40;
  const perRow = 32;
  const step = 2;
  const messageBytes = 16 * 1024;
  const messages: string[] = [];
  for (let index = 0; index < perRow + (rows - 1) * step; index++)
    messages.push(
      JSON.stringify({
        role: index % 2 === 0 ? "user" : "assistant",
        content: variedContent(index + 1, messageBytes),
      }),
    );
  const batch = Array.from({ length: rows }, (_, index) =>
    record(
      `r-${index}`,
      `{"messages":[${messages.slice(index * step, index * step + perRow).join(",")}]}`,
      `2099-02-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
    ),
  );
  const sourceBytes = batch.reduce((total, row) => total + Buffer.byteLength(row.input, "utf8"), 0);
  const uniqueMessages = perRow + (rows - 1) * step;
  console.log(
    `corpus: rows=${rows} messages_per_row=${perRow} unique_messages=${uniqueMessages} repeated_instances=${rows * perRow} source_bytes=${sourceBytes}`,
  );
  const wal: Record<string, number> = {};
  for (const cas of ["off", "on"] as const) {
    const path = join(directory, `wal-${cas}.db`);
    const adapter = await adapterFor(path, cas);
    const db = adapter.getDatabase();
    await db.exec("PRAGMA wal_autocheckpoint=0");
    await adapter.insert({ table: "observations", records: batch });
    wal[cas] = walBytes(path);
    const pool = (await db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(length(payload)),0) AS payload_bytes FROM io_cas_chunks WHERE project_id='p'",
    )) as { n: number; payload_bytes: number };
    const stored = (await db.get(
      "SELECT input_codec, length(input) AS bytes FROM observations WHERE id='r-0'",
    )) as { input_codec: number; bytes: number };
    const rowIo = (await db.get(
      "SELECT COALESCE(SUM(length(input)),0) AS bytes FROM observations WHERE project_id='p'",
    )) as { bytes: number };
    console.log(
      `wal[cas=${cas}]: wal_bytes=${wal[cas]} row_codec=${stored.input_codec} row_input_bytes=${stored.bytes} row_io_bytes=${rowIo.bytes} pool_rows=${pool.n} pool_payload_bytes=${pool.payload_bytes}`,
    );
    await adapter.close();
  }
  console.log(
    `wal reduction: ${(((wal.off - wal.on) / wal.off) * 100).toFixed(1)}% (off=${wal.off} on=${wal.on})`,
  );

  // 4) 小请求（≤4KiB）CAS on/off 对比：预热后交替测量，抵消时间漂移。
  const smallMs: Record<string, number[]> = { off: [], on: [] };
  const smallAdapters = {
    off: await adapterFor(join(directory, "small-off.db"), "off"),
    on: await adapterFor(join(directory, "small-on.db"), "on"),
  };
  for (const cas of ["off", "on"] as const)
    for (let index = 0; index < 20; index++)
      await smallAdapters[cas].insert({
        table: "observations",
        records: [record(`warm-${index}`, small, "2099-03-01T00:00:00Z")],
      });
  for (let index = 0; index < 300; index++) {
    for (const cas of ["off", "on"] as const) {
      const start = performance.now();
      await smallAdapters[cas].insert({
        table: "observations",
        records: [record(`s-${index}`, small, "2099-04-01T00:00:00Z")],
      });
      smallMs[cas].push(performance.now() - start);
    }
  }
  for (const cas of ["off", "on"] as const) {
    console.log(
      `small(${Buffer.byteLength(small, "utf8")}B, cas=${cas}): p50=${percentile(smallMs[cas], 0.5).toFixed(3)}ms p90=${percentile(smallMs[cas], 0.9).toFixed(3)}ms p95=${percentile(smallMs[cas], 0.95).toFixed(3)}ms`,
    );
    await smallAdapters[cas].close();
  }
  const p95Off = percentile(smallMs.off, 0.95);
  const p95On = percentile(smallMs.on, 0.95);
  console.log(
    `small p95 delta: ${(((p95On - p95Off) / p95Off) * 100).toFixed(1)}% (off=${p95Off.toFixed(3)}ms on=${p95On.toFixed(3)}ms)`,
  );
  // 配对差值（同样本相邻测量）比两个独立 p95 更抗调度噪声。
  const paired = smallMs.on.map(
    (value, index) => (value - smallMs.off[index]) / smallMs.off[index],
  );
  console.log(
    `small paired delta: p50=${(percentile(paired, 0.5) * 100).toFixed(1)}% p95=${(percentile(paired, 0.95) * 100).toFixed(1)}% (n=${paired.length})`,
  );
  console.log("cas-write-bench: OK");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
