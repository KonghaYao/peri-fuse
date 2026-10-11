import { decodeChunk } from "./chunk-codec";
import { contentHash, equalBytes, HASH_BYTES, hashToHex } from "./hash";
import type { PreparedCas, PreparedChunk } from "./prepare";

/**
 * CAS 的**物理发布**（设计 §6 步骤 1–6 的第 1–5 步）：内容池存在性确认、缺失补插、
 * 严格原文比对与写屏障。全部动作必须与调用方的行写入处于**同一个事务**：
 * 同一 `tx` 上先发布池内容与屏障，再由调用方写 `observations` 的三列组，
 * 崩溃时两者一起回滚，不产生已提交的悬空根（W5 ②/③）。
 *
 * ## 隔离与权限（W5 ⑧）
 *
 * - 池表与 `observations` 同在 **telemetry** 库，绝不跨 metadata/telemetry 库做伪原子事务；
 *   本模块只接受显式 `tx` 句柄，不提供"自己开事务"的入口。
 * - `projectId` 是每个 API 的必填参数（`string`），空值抛 `IO_CAS_PROJECT_REQUIRED`：
 *   池内容按项目隔离，跨项目共享在契约上不可表达。
 *
 * ## 与读端的关系
 *
 * 读端（`read.ts`）在同一读快照里装配；写端只负责让"行引用的内容"在提交前确实存在于池中。
 * 缓存命中**不会**跳过这里：GC 可能刚删块，存在性确认与比对每写必做（W5 ⑦）。
 */

/** 单次池查询允许的最大 hash 数（与读端 `HYDRATE_BATCH_LIMIT` 一致）。 */
export const CAS_POOL_BATCH_LIMIT = 128;

/** 事务内的最小查询接口（`Transaction` 与 `Database` 均满足）。 */
export interface CasWriteTx {
  get(sql: string, ...params: unknown[]): Promise<unknown>;
  all(sql: string, ...params: unknown[]): Promise<unknown[]>;
  run(sql: string, ...params: unknown[]): Promise<unknown>;
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    result.push(items.slice(start, start + size));
  return result;
}

function assertProject(projectId: string): void {
  if (typeof projectId !== "string" || projectId.length === 0)
    throw new Error("IO_CAS_PROJECT_REQUIRED");
}

function hashPlaceholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

interface StoredChunk {
  codec: number;
  rawSize: number;
  payload: Uint8Array;
  hash: Uint8Array;
}

function readStoredChunk(row: Record<string, unknown>): StoredChunk {
  const hash = row.content_hash;
  if (!(hash instanceof Uint8Array) || hash.byteLength !== HASH_BYTES)
    throw new Error("IO_CAS_INVALID");
  const rawSize = Number(row.raw_size);
  if (!Number.isSafeInteger(rawSize) || rawSize < 0) throw new Error("IO_CAS_INVALID");
  const payload = row.payload;
  if (!(payload instanceof Uint8Array)) throw new Error("IO_CAS_INVALID");
  const codec = Number(row.codec);
  if (codec !== 0 && codec !== 1) throw new Error("IO_CAS_VERSION");
  return { codec, rawSize, payload, hash };
}

/**
 * 严格原文比对：`raw_size` 必须相同，内容按原文比较（codec 相同的比 payload，
 * codec 不同时先有界解码），并再次核验内容 hash 与键一致。任何不符返回 `false`，
 * 由调用方重读核验后决定是否报错。
 */
function matchesStored(stored: StoredChunk, chunk: PreparedChunk): boolean {
  if (stored.rawSize !== chunk.rawSize) return false;
  const expected = chunk.raw;
  if (stored.codec === chunk.codec) {
    if (!equalBytes(stored.payload, chunk.payload)) return false;
  } else {
    let decoded: Uint8Array;
    try {
      decoded = decodeChunk({
        codec: stored.codec,
        rawSize: stored.rawSize,
        payload: stored.payload,
      });
    } catch {
      return false;
    }
    if (!equalBytes(decoded, expected)) return false;
  }
  return equalBytes(contentHash(expected), stored.hash) && equalBytes(stored.hash, chunk.hash);
}

async function selectChunks(
  tx: CasWriteTx,
  projectId: string,
  hashes: readonly Uint8Array[],
): Promise<Map<string, StoredChunk>> {
  const rows = (await tx.all(
    `SELECT content_hash, codec, raw_size, payload FROM io_cas_chunks
     WHERE project_id = ? AND content_hash IN (${hashPlaceholders(hashes.length)})`,
    projectId,
    ...hashes,
  )) as Record<string, unknown>[];
  const found = new Map<string, StoredChunk>();
  for (const row of rows) {
    const stored = readStoredChunk(row);
    const hex = hashToHex(stored.hash);
    if (found.has(hex)) throw new Error("IO_CAS_INVALID");
    found.set(hex, stored);
  }
  return found;
}

/**
 * 发布一次 CAS 负载（设计 §6 步骤 1–5），必须在调用方的事务内执行。
 *
 * 1. 按 `project_id + content_hash IN (…)` 批量读池（每批 ≤`batchSize`，默认 128）；
 * 2. 缺失的 hash 单条多值补插：`ON CONFLICT(project_id, content_hash) DO NOTHING`
 *    —— 只忽略该唯一键冲突，不使用宽泛的 `OR IGNORE`；补插行数少于缺失数
 *    （说明他人先插入了同名内容）时重读整批并走步骤 3 的严格比对；
 * 3. 对每一条读到的存在行做严格原文比对（`raw_size` + codec/payload 或解码原文
 *    + 内容 hash），不符即整批重读核验一次，仍不符抛 `IO_CAS_CORRUPT`
 *    （坏池内容绝不带进根）；本事务补插成功的行以 INSERT 的写入语义为准，不读回；
 * 4. 全部 hash 必须能在同事务内查到，否则 `IO_CAS_MISSING`；
 * 5. 写屏障：调用 `markReferenced(tx, projectId, hashes, epoch)`（见其契约）。
 *
 * 幂等：同一内容重复发布只会走"存在且一致"的路径，插入 0 行。
 */
export async function publishCasInput(
  tx: CasWriteTx,
  projectId: string,
  prepared: PreparedCas,
  options: { epoch?: number; batchSize?: number } = {},
): Promise<void> {
  assertProject(projectId);
  const batchSize = Math.min(options.batchSize ?? CAS_POOL_BATCH_LIMIT, CAS_POOL_BATCH_LIMIT);
  const byHex = new Map(prepared.chunks.map((chunk) => [hashToHex(chunk.hash), chunk]));
  if (byHex.size !== prepared.chunks.length) throw new Error("IO_CAS_INVALID");

  for (const batch of batches(prepared.chunks, batchSize)) {
    const hashes = batch.map((chunk) => chunk.hash);
    let stored = await selectChunks(tx, projectId, hashes);
    const missing = batch.filter((chunk) => !stored.has(hashToHex(chunk.hash)));
    const missingHex = new Set(missing.map((chunk) => hashToHex(chunk.hash)));
    if (missing.length > 0) {
      // 单条多值 INSERT（每批 ≤128 行 × 5 列 = 640 个参数，远低于 SQLite 上限）：
      // 首次写入一批新内容只需 1 次补插，写锁持有时间与行数无关。
      const values = new Array(missing.length).fill("(?, ?, ?, ?, ?)").join(", ");
      const params: unknown[] = [];
      for (const chunk of missing)
        params.push(projectId, chunk.hash, chunk.codec, chunk.rawSize, chunk.payload);
      const result = (await tx.run(
        `INSERT INTO io_cas_chunks(project_id, content_hash, codec, raw_size, payload)
         VALUES ${values}
         ON CONFLICT(project_id, content_hash) DO NOTHING`,
        ...params,
      )) as { changes?: number } | undefined;
      // 插入行数与缺失数相同时，这些行就是本事务写入的参数（IMMEDIATE 写锁下
      // 不存在并发写者），无需读回 480KiB 级 payload 逐块复核；只有行数不吻合
      // 才可能引入了他人写入的内容，此时重读并严格比对（设计 §6 冲突重新核验）。
      if (Number(result?.changes ?? 0) < missing.length)
        stored = await selectChunks(tx, projectId, hashes);
    }
    for (const chunk of batch) {
      const hex = hashToHex(chunk.hash);
      const row = stored.get(hex);
      if (!row) {
        // 只在「本事务补插成功」的路径上允许缺行（内容已在插入时由参数保证）。
        if (!missingHex.has(hex)) throw new Error("IO_CAS_MISSING");
        continue;
      }
      if (matchesStored(row, chunk)) continue;
      // 冲突重新核验：重读一次，仍不符即坏池内容，整事务回滚。
      const rechecked = await selectChunks(tx, projectId, [chunk.hash]);
      const fresh = rechecked.get(hex);
      if (!fresh || !matchesStored(fresh, chunk)) throw new Error("IO_CAS_CORRUPT");
    }
  }

  await markReferenced(
    tx,
    projectId,
    prepared.chunks.map((chunk) => chunk.hash),
    options.epoch ?? 0,
  );
}

/**
 * 写屏障（设计 §6 步骤 5）。**W5 交付、W6 复用；不允许另写一份实现。**
 *
 * 契约：
 * - 无该项目的 `io_cas_gc_state` 行（GC 从未运行）→ 0 次 UPDATE，返回 0。
 * - `phase ∈ {mark, sweep}` → 对每个 hash 执行 `mark_epoch = max(mark_epoch, epoch)`，
 *   且**只更新 `mark_epoch < epoch` 的旧行**，分块 ≤`CAS_POOL_BATCH_LIMIT`。
 * - `phase ∈ {idle, blocked}` → 0 次 UPDATE，返回 0（无回收在进行）。
 * - 幂等：重复调用在 `mark_epoch` 已达标时更新 0 行；返回值仅用于观测。
 * - `epoch` 由调用方给出（GC 的 mark/sweep 轮次）；实际生效值取
 *   `max(epoch, state.epoch)`，因此**过期的 epoch 不会削弱保护**：GC 提升 epoch 后，
 *   写入方即便拿到旧值，也只会把内容标到更高的当前轮次。
 * - 空 `projectId` 抛 `IO_CAS_PROJECT_REQUIRED`；空 `hashes` 直接返回 0。
 */
export async function markReferenced(
  tx: CasWriteTx,
  projectId: string,
  hashes: readonly Uint8Array[],
  epoch: number,
): Promise<number> {
  assertProject(projectId);
  if (hashes.length === 0) return 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("IO_CAS_INVALID");
  const state = (await tx.get(
    "SELECT epoch, phase FROM io_cas_gc_state WHERE project_id = ?",
    projectId,
  )) as { epoch?: unknown; phase?: unknown } | undefined;
  if (!state) return 0;
  const phase = String(state.phase);
  if (phase !== "mark" && phase !== "sweep") return 0;
  const stateEpoch = Number(state.epoch);
  if (!Number.isSafeInteger(stateEpoch) || stateEpoch < 0) throw new Error("IO_CAS_INVALID");
  const target = Math.max(stateEpoch, epoch);
  let updated = 0;
  for (const batch of batches(hashes, CAS_POOL_BATCH_LIMIT)) {
    const result = (await tx.run(
      `UPDATE io_cas_chunks SET mark_epoch = ?
       WHERE project_id = ? AND mark_epoch < ? AND content_hash IN (${hashPlaceholders(batch.length)})`,
      target,
      projectId,
      target,
      ...batch,
    )) as { changes?: number } | undefined;
    updated += Number(result?.changes ?? 0);
  }
  return updated;
}
