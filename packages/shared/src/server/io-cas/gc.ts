import type { Transaction } from "@tursodatabase/database";
import {
  assertReadSnapshotSupported,
  type LocalDatabase,
  withLocalTransaction,
} from "../../db/local";
import { IO_CAS_ROOTS_INDEX_NAME, IO_CAS_ROOTS_INDEX_SQL } from "../../db/telemetry/io-cas-tables";
import {
  advanceRootCursor,
  advanceSweepCursor,
  beginSweep,
  blockCasGc,
  CAS_GC_EPOCH_EXHAUSTED,
  type CasGcPhase,
  type CasGcState,
  type CasGcTx,
  ensureCasGcState,
  finishSweep,
  readCasGcState,
  resetCasGcBlocked,
  startMarkRound,
} from "./gc-state";
import { HASH_BYTES } from "./hash";
import { collectRefHashes, parseManifest } from "./manifest";
import { IO_CAS_CODEC } from "./read";
import { markReferenced } from "./write";

/**
 * CAS 池的标记清扫（设计 §8.2，W6）：单步状态机与索引/项目发现。
 * 作业调度与 pass 循环见 `gc-job.ts`。
 *
 * ## 状态机与事务边界
 *
 * `idle → mark → sweep → idle`（+ `blocked`）。**每一步都是一次独立的短 immediate 事务**，
 * 并在事务内重读 `io_cas_gc_state`：即使多个进程/定时器同时驱动同一项目，后到者看到
 * 已推进的 phase 就只做该 phase 的下一批，绝不会把过期状态写回去。状态迁移与它对应的
 * 效果（`markReferenced` / 条件删除）同事务提交，崩溃后从持久游标继续。
 *
 * ## mark（根扫描）
 *
 * 每批 ≤64 根、manifest 解码预算 1MiB；**单个超预算根独占一批**（不会被预算饿死）。
 * 游标是观测 id 的 keyset（`id > cursor ORDER BY id LIMIT n`），**不用 OFFSET**：
 * OFFSET 在游标前后插入/删除时会跳过或重复行。根扫描**不**过滤软删除标记 ——
 * 被软删除的行仍是根（设计 §8.2），只有硬删除才会让内容失去引用。
 *
 * ## sweep（条件清扫）
 *
 * 每批 ≤256，`DELETE ... WHERE mark_epoch < epoch AND content_hash IN (批)` —— 读取与删除
 * 在**同一个 immediate 事务**内（写锁已持有），删除语句自身再判一次 `mark_epoch < epoch`，
 * 因此不存在"事务外先读后删"把刚被写屏障提升的内容删掉的可能。
 *
 * ## 写屏障
 *
 * 复用 W5 的 `markReferenced`（**唯一实现**，不允许另写一份）：mark/sweep 期间写入方
 * 把被引用内容提升到当前 epoch，因此扫不到的并发写入不会成为垃圾。
 *
 * ## 门禁
 *
 * NO-GO 引擎（W1 未验证快照能力）显式拒绝：入口抛 `PERIFUSE_READ_SNAPSHOT_UNSUPPORTED`，
 * 绝不"绕过门禁继续跑"。
 */

/** 每批根数（设计 §8.2）。 */
export const CAS_GC_ROOT_BATCH = 64;
/** 每批 manifest 解码预算（字节，按存储的 manifest 字节计）。 */
export const CAS_GC_DECODE_BUDGET_BYTES = 1024 * 1024;
/** 每批清扫的池行数。 */
export const CAS_GC_SWEEP_BATCH = 256;

export interface CasGcStepOptions {
  /** 每批读取的根数，默认 64，硬上限 64。 */
  rootBatch?: number;
  /** 每批 manifest 解码预算字节数，默认 1MiB。 */
  decodeBudgetBytes?: number;
  /** 每批清扫的池行数，默认 256。 */
  sweepBatch?: number;
}

export interface CasGcStepResult {
  projectId: string;
  /** 本步提交后的 phase。 */
  phase: CasGcPhase;
  /** 本轮结束（进入 idle）或被 blocked。 */
  done: boolean;
  epoch: number;
  /** 本步处理的根数。 */
  roots: number;
  /** `markReferenced` 实际更新的池行数。 */
  marked: number;
  /** 本步条件删除的池行数。 */
  swept: number;
  /** blocked 原因（仅 phase=blocked）。 */
  blocked: string | null;
}

function requireProject(projectId: string): void {
  if (typeof projectId !== "string" || projectId.length === 0)
    throw new Error("IO_CAS_PROJECT_REQUIRED");
}

/** 门禁：GC 只能在 W1 验证过快照能力的引擎上运行。 */
function assertCasGcEngine(db: object): void {
  assertReadSnapshotSupported(db);
}

/** 事务提交前把损坏的根记为 blocked：坏 manifest 绝不进入 sweep。 */
function describeRootFailure(error: unknown, rootId: string): string {
  const message = error instanceof Error ? error.message : "";
  const code = /^IO_CAS_[A-Z_]+$/.test(message) ? message : "IO_CAS_INVALID";
  return `${code} root=${rootId}`;
}

function blockedResult(state: CasGcState, reason: string | null): CasGcStepResult {
  return {
    projectId: state.projectId,
    phase: "blocked",
    done: true,
    epoch: state.epoch,
    roots: 0,
    marked: 0,
    swept: 0,
    blocked: reason,
  };
}

function rootScanSql(columns: string, withCursor: boolean): string {
  return `SELECT ${columns} FROM observations
    WHERE project_id = ? AND input_codec = ?${withCursor ? " AND id > ?" : ""}
    ORDER BY id LIMIT ?`;
}

/** 预算内的根前缀长度：至少 1（单个超预算根独占一批），且不超过本批条数。 */
function budgetPrefix(sizes: readonly number[], budget: number): number {
  let take = 0;
  let bytes = 0;
  for (const size of sizes) {
    if (take > 0 && bytes + size > budget) break;
    bytes += size;
    take += 1;
  }
  return take;
}

/**
 * mark 的一批：读根 → 解析 manifest → `markReferenced` → 推进游标（或转入 sweep）。
 *
 * 先只取 `length(input)` 选前缀、再取该前缀的 blob：把一批的内存/解码上限压在预算内，
 * 而不是先把 64 个根（最坏 64×32MiB）全部读进内存再判断。
 */
async function markRootBatch(
  tx: Transaction,
  state: CasGcState,
  options: CasGcStepOptions,
): Promise<CasGcStepResult> {
  const projectId = state.projectId;
  const budget = Math.max(1, options.decodeBudgetBytes ?? CAS_GC_DECODE_BUDGET_BYTES);
  const batch = Math.min(Math.max(1, options.rootBatch ?? CAS_GC_ROOT_BATCH), CAS_GC_ROOT_BATCH);
  const cursor = state.rootCursor;
  const base = cursor === null ? [projectId, IO_CAS_CODEC] : [projectId, IO_CAS_CODEC, cursor];
  const sizes = (await tx.all(
    rootScanSql("id, length(input) AS bytes", cursor !== null),
    ...base,
    batch,
  )) as { id: unknown; bytes: unknown }[];
  const empty = {
    projectId,
    done: false,
    epoch: state.epoch,
    roots: 0,
    marked: 0,
    swept: 0,
    blocked: null,
  };
  if (sizes.length === 0) {
    await beginSweep(tx, projectId);
    return { ...empty, phase: "sweep" };
  }
  const take = budgetPrefix(
    sizes.map((row) => Math.max(0, Number(row.bytes) || 0)),
    budget,
  );
  const rows = (await tx.all(rootScanSql("id, input", cursor !== null), ...base, take)) as {
    id: unknown;
    input: unknown;
  }[];
  if (rows.length !== take) throw new Error("IO_CAS_INVALID");

  const seen = new Set<string>();
  const hashes: Uint8Array[] = [];
  let lastId = cursor;
  for (const row of rows) {
    const id = String(row.id);
    const buffer = row.input;
    if (!(buffer instanceof Uint8Array)) {
      const reason = describeRootFailure(new Error("IO_CAS_INVALID"), id);
      await blockCasGc(tx, projectId, reason);
      return blockedResult({ ...state, phase: "blocked" }, reason);
    }
    let manifest: ReturnType<typeof parseManifest>;
    try {
      manifest = parseManifest(buffer);
    } catch (error) {
      const reason = describeRootFailure(error, id);
      await blockCasGc(tx, projectId, reason);
      return blockedResult({ ...state, phase: "blocked" }, reason);
    }
    for (const key of collectRefHashes(manifest)) {
      if (seen.has(key.hex)) continue;
      seen.add(key.hex);
      hashes.push(key.hash);
    }
    lastId = id;
  }
  const marked = await markReferenced(tx, projectId, hashes, state.epoch);
  if (lastId !== null) await advanceRootCursor(tx, projectId, lastId);
  return { ...empty, phase: "mark", roots: rows.length, marked };
}

/** sweep 的一批：同事务内先读批次、再条件删除，最后推进游标或结束本轮。 */
async function sweepChunkBatch(
  tx: Transaction,
  state: CasGcState,
  options: CasGcStepOptions,
): Promise<CasGcStepResult> {
  const projectId = state.projectId;
  const batch = Math.max(1, options.sweepBatch ?? CAS_GC_SWEEP_BATCH);
  const cursor = state.sweepCursor;
  const base = [projectId, state.epoch];
  const rows = (await tx.all(
    `SELECT content_hash FROM io_cas_chunks
     WHERE project_id = ? AND mark_epoch < ?${cursor === null ? "" : " AND content_hash > ?"}
     ORDER BY content_hash LIMIT ?`,
    ...(cursor === null ? base : [...base, cursor]),
    batch,
  )) as { content_hash: unknown }[];
  const hashes = rows.map((row) => row.content_hash);
  if (hashes.some((hash) => !(hash instanceof Uint8Array) || hash.byteLength !== HASH_BYTES))
    throw new Error("IO_CAS_INVALID");
  const settled = {
    projectId,
    done: true,
    epoch: state.epoch,
    roots: 0,
    marked: 0,
    swept: 0,
    blocked: null,
  };
  if (hashes.length === 0) {
    await finishSweep(tx, projectId);
    return { ...settled, phase: "idle" };
  }
  // 删除语句自身再判一次 mark_epoch：只删未达当前 epoch 的内容。
  const placeholders = new Array(hashes.length).fill("?").join(",");
  const result = (await tx.run(
    `DELETE FROM io_cas_chunks
     WHERE project_id = ? AND mark_epoch < ? AND content_hash IN (${placeholders})`,
    projectId,
    state.epoch,
    ...(hashes as Uint8Array[]),
  )) as { changes?: unknown } | undefined;
  const swept = Number(result?.changes ?? 0);
  if (hashes.length < batch) {
    await finishSweep(tx, projectId);
    return { ...settled, phase: "idle", swept };
  }
  await advanceSweepCursor(tx, projectId, hashes[hashes.length - 1] as Uint8Array);
  return { ...settled, done: false, phase: "sweep", swept };
}

/**
 * 驱动一个项目的状态机走**一步**（一次独立 immediate 事务）。
 *
 * 事务内重读 state：idle 起步新一轮（epoch+1）、mark 处理一批根、sweep 处理一批池行。
 * `blocked` 项目在这返回 `done`（不自动重试，等待运维修复 + `clearCasGcBlocked`）。
 */
export async function runCasGcStep(
  db: LocalDatabase,
  projectId: string,
  options: CasGcStepOptions = {},
): Promise<CasGcStepResult> {
  requireProject(projectId);
  assertCasGcEngine(db);
  return withLocalTransaction(db, async (tx) => {
    const state = await ensureCasGcState(tx as CasGcTx, projectId);
    if (state.phase === "blocked") return blockedResult(state, state.lastError);
    if (state.phase === "idle") {
      const epoch = await startMarkRound(tx as CasGcTx, state);
      if (epoch === null)
        return blockedResult({ ...state, phase: "blocked" }, CAS_GC_EPOCH_EXHAUSTED);
      return {
        projectId,
        phase: "mark" as const,
        done: false,
        epoch,
        roots: 0,
        marked: 0,
        swept: 0,
        blocked: null,
      };
    }
    return state.phase === "mark"
      ? markRootBatch(tx, state, options)
      : sweepChunkBatch(tx, state, options);
  });
}

export interface CasRootsIndexResult {
  /** D-1：首次 mark 扫描前显式建索引（幂等）；本字段区分是否真的建了。 */
  created: boolean;
  elapsedMs: number;
}

/**
 * D-1：`idx_obs_cas_roots` 不在启动 migration 里执行（1.5GB 表启动建索引会持写锁）。
 * GC 在**第一次根扫描之前**显式执行它；已存在时只做一次 `sqlite_master` 查询。
 * 不在 NO-GO 引擎上建这把索引：建索引本身就是 GC 启动的一部分，不允许绕过门禁。
 */
export async function ensureCasRootsIndex(db: LocalDatabase): Promise<CasRootsIndexResult> {
  assertCasGcEngine(db);
  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'",
  );
  if (!table) return { created: false, elapsedMs: 0 };
  const index = await db.get(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
    IO_CAS_ROOTS_INDEX_NAME,
  );
  if (index) return { created: false, elapsedMs: 0 };
  const started = performance.now();
  await db.run(IO_CAS_ROOTS_INDEX_SQL);
  return { created: true, elapsedMs: performance.now() - started };
}

/**
 * 项目发现：需要 GC 的项目 =
 * ① 状态非 idle（进程重启后续跑）∪ ② 池里有内容（retention 删光根后仍要清池）∪
 * ③ 有 codec 2 根（新项目，含软删除行）。全部按 project_id 隔离。
 */
export async function discoverCasGcProjects(db: LocalDatabase): Promise<string[]> {
  const hasObservations = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'",
  );
  const roots = hasObservations
    ? "UNION SELECT project_id FROM observations WHERE input_codec = 2"
    : "";
  const rows = (await db.all(
    `SELECT project_id FROM io_cas_gc_state WHERE phase <> 'idle'
     UNION SELECT project_id FROM io_cas_chunks
     ${roots}
     ORDER BY project_id`,
  )) as { project_id: unknown }[];
  return rows.map((row) => String(row.project_id)).filter((projectId) => projectId.length > 0);
}

/** 运维/测试复位：解除某个项目的 blocked（下一轮重新全量 mark）。 */
export async function clearCasGcBlocked(db: LocalDatabase, projectId: string): Promise<boolean> {
  requireProject(projectId);
  assertCasGcEngine(db);
  return withLocalTransaction(db, (tx) => resetCasGcBlocked(tx as CasGcTx, projectId));
}

/** 读状态（不改变状态；运维观测与测试断言用）。 */
export async function readCasGcPhase(
  db: LocalDatabase,
  projectId: string,
): Promise<CasGcState | null> {
  requireProject(projectId);
  assertCasGcEngine(db);
  return withLocalTransaction(db, (tx) => readCasGcState(tx as CasGcTx, projectId));
}
