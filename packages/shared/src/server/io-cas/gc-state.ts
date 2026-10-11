import { HASH_BYTES } from "./hash";

/**
 * `io_cas_gc_state`（设计 §5.3）的持久状态机（W6，设计 §8.2）。
 *
 * ```
 *            (进入 mark 时 epoch+1)
 *   idle ─────────────────────────▶ mark ───────────▶ sweep ───────▶ idle
 *     ▲                              │                  │
 *     └──────────────────────────────┴──────────────────┘
 *              坏 manifest → blocked（修复后 reset 再继续）
 * ```
 *
 * 契约：
 *
 * - 本模块只接受**调用方已打开的事务句柄**。状态迁移必须与它对应的效果
 *   （标记池内容 / 条件删除）在同一个 immediate 事务内提交，崩溃后从持久游标继续，
 *   不存在"状态已推进、效果未落地"的窗口。
 * - `epoch` 是**单调不回绕**的轮次号：进入 mark 时 +1。达到安全整数上限后**停止 GC、
 *   绝不归零重用** —— 归零会让上一轮的 `mark_epoch` 变成"未来值"，仍在被引用的内容
 *   会被误判成垃圾。
 * - 所有语句都以 `project_id` 限定：状态与池内容按项目隔离，跨项目不可见。
 */

export const CAS_GC_PHASES = ["idle", "mark", "sweep", "blocked"] as const;
export type CasGcPhase = (typeof CAS_GC_PHASES)[number];

/** epoch 取值上限：SQLite INTEGER 与 JS 安全整数的交集。 */
export const CAS_GC_MAX_EPOCH = Number.MAX_SAFE_INTEGER;

/** 达到 epoch 上限时的 last_error（GC 停止，绝不归零重用）。 */
export const CAS_GC_EPOCH_EXHAUSTED = "IO_CAS_GC_EPOCH_EXHAUSTED";

/** 事务内的最小查询接口（`Transaction` 与 `Database` 均满足）。 */
export interface CasGcTx {
  get(sql: string, ...params: unknown[]): Promise<unknown>;
  run(sql: string, ...params: unknown[]): Promise<unknown>;
}

export interface CasGcState {
  projectId: string;
  epoch: number;
  phase: CasGcPhase;
  /** 观测 id 的 keyset 游标；`null` 表示从最小 id 开始扫描。 */
  rootCursor: string | null;
  /** 32B content_hash 的 keyset 游标；`null` 表示从最小 hash 开始清扫。 */
  sweepCursor: Uint8Array | null;
  lastError: string | null;
}

function isPhase(value: string): value is CasGcPhase {
  return (CAS_GC_PHASES as readonly string[]).includes(value);
}

/**
 * 解析状态行。任何字段形状不符都抛 `IO_CAS_INVALID`（**不静默降级**：
 * 一个无法解释的 phase/epoch 会让清扫删错内容，宁可让维护作业停在这里）。
 */
export function parseCasGcState(row: Record<string, unknown>, projectId: string): CasGcState {
  const epoch = Number(row.epoch);
  const phase = String(row.phase);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !isPhase(phase))
    throw new Error("IO_CAS_INVALID");
  const rootCursor = row.root_cursor;
  if (rootCursor !== null && rootCursor !== undefined && typeof rootCursor !== "string")
    throw new Error("IO_CAS_INVALID");
  const sweepCursor = row.sweep_cursor;
  if (sweepCursor !== null && sweepCursor !== undefined) {
    if (!(sweepCursor instanceof Uint8Array) || sweepCursor.byteLength !== HASH_BYTES)
      throw new Error("IO_CAS_INVALID");
  }
  const lastError = row.last_error;
  return {
    projectId,
    epoch,
    phase,
    rootCursor: typeof rootCursor === "string" ? rootCursor : null,
    sweepCursor: sweepCursor instanceof Uint8Array ? sweepCursor : null,
    lastError: lastError === null || lastError === undefined ? null : String(lastError),
  };
}

/** 读状态行；项目从未跑过 GC 时返回 `null`（写屏障据此 0 次 UPDATE）。 */
export async function readCasGcState(tx: CasGcTx, projectId: string): Promise<CasGcState | null> {
  const row = (await tx.get(
    "SELECT epoch, phase, root_cursor, sweep_cursor, last_error FROM io_cas_gc_state WHERE project_id = ?",
    projectId,
  )) as Record<string, unknown> | undefined;
  return row ? parseCasGcState(row, projectId) : null;
}

/** 幂等建行：`ON CONFLICT DO NOTHING`，并发/重复调用都不会重置既有进度。 */
export async function ensureCasGcState(tx: CasGcTx, projectId: string): Promise<CasGcState> {
  await tx.run(
    `INSERT INTO io_cas_gc_state(project_id, epoch, phase) VALUES(?, 0, 'idle')
     ON CONFLICT(project_id) DO NOTHING`,
    projectId,
  );
  const state = await readCasGcState(tx, projectId);
  if (!state) throw new Error("IO_CAS_INVALID");
  return state;
}

function assertUpdated(result: unknown): void {
  const changes = Number((result as { changes?: unknown } | undefined)?.changes ?? 0);
  if (changes !== 1) throw new Error("IO_CAS_INVALID");
}

/**
 * 进入新一轮 mark：epoch+1（安全整数，绝不回绕）。返回新 epoch；
 * 已达上限时把项目置为 `blocked` 并返回 `null`（调用方停止本项目的 GC）。
 */
export async function startMarkRound(tx: CasGcTx, state: CasGcState): Promise<number | null> {
  if (state.epoch >= CAS_GC_MAX_EPOCH) {
    await blockCasGc(tx, state.projectId, CAS_GC_EPOCH_EXHAUSTED);
    return null;
  }
  const epoch = state.epoch + 1;
  assertUpdated(
    await tx.run(
      `UPDATE io_cas_gc_state
       SET epoch = ?, phase = 'mark', root_cursor = NULL, sweep_cursor = NULL,
           last_error = NULL, updated_at = datetime('now')
       WHERE project_id = ?`,
      epoch,
      state.projectId,
    ),
  );
  return epoch;
}

/** mark 扫描结束：清空根游标，开始清扫（同事务提交）。 */
export async function beginSweep(tx: CasGcTx, projectId: string): Promise<void> {
  assertUpdated(
    await tx.run(
      `UPDATE io_cas_gc_state
       SET phase = 'sweep', root_cursor = NULL, sweep_cursor = NULL, updated_at = datetime('now')
       WHERE project_id = ?`,
      projectId,
    ),
  );
}

/** 清扫结束：回到 idle（epoch 保留，下一轮再 +1）。 */
export async function finishSweep(tx: CasGcTx, projectId: string): Promise<void> {
  assertUpdated(
    await tx.run(
      `UPDATE io_cas_gc_state
       SET phase = 'idle', root_cursor = NULL, sweep_cursor = NULL, updated_at = datetime('now')
       WHERE project_id = ?`,
      projectId,
    ),
  );
}

export async function advanceRootCursor(
  tx: CasGcTx,
  projectId: string,
  rootCursor: string,
): Promise<void> {
  assertUpdated(
    await tx.run(
      `UPDATE io_cas_gc_state SET root_cursor = ?, updated_at = datetime('now')
       WHERE project_id = ?`,
      rootCursor,
      projectId,
    ),
  );
}

export async function advanceSweepCursor(
  tx: CasGcTx,
  projectId: string,
  sweepCursor: Uint8Array,
): Promise<void> {
  assertUpdated(
    await tx.run(
      `UPDATE io_cas_gc_state SET sweep_cursor = ?, updated_at = datetime('now')
       WHERE project_id = ?`,
      sweepCursor,
      projectId,
    ),
  );
}

/** 进入 blocked：GC 不越过这一步（坏根绝不进入 sweep），错误留给运维处置。 */
export async function blockCasGc(tx: CasGcTx, projectId: string, reason: string): Promise<void> {
  assertUpdated(
    await tx.run(
      `UPDATE io_cas_gc_state
       SET phase = 'blocked', last_error = ?, updated_at = datetime('now')
       WHERE project_id = ?`,
      reason,
      projectId,
    ),
  );
}

/**
 * 运维/测试用复位：仅当项目处于 `blocked` 时回到 idle 并清空 last_error，
 * 下一轮从 epoch+1 重新全量 mark（被阻断的一轮放弃，内容保护不受影响）。
 */
export async function resetCasGcBlocked(tx: CasGcTx, projectId: string): Promise<boolean> {
  const result = await tx.run(
    `UPDATE io_cas_gc_state
     SET phase = 'idle', root_cursor = NULL, sweep_cursor = NULL, last_error = NULL,
         updated_at = datetime('now')
     WHERE project_id = ? AND phase = 'blocked'`,
    projectId,
  );
  return Number((result as { changes?: unknown } | undefined)?.changes ?? 0) === 1;
}
