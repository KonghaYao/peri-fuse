import { decodeIoRow } from "../adapters/io-compression";
import type { CasPrepareCache, PreparedCas } from "./prepare";
import { IO_CAS_CODEC } from "./read";

/**
 * W7（回填 / expand）的共享契约：执行面类型、批与阈值常量、迁移状态读写、
 * keyset 分页 SQL 与行快照比对。`migration.ts`（计划/应用/主循环）、
 * `migration-audit.ts`（dry-run / 残余重扫 / 完整校验）、`migration-stops.ts`
 * （停止条件）都只依赖本模块，模块图无环。
 *
 * 契约要点（完整理由见 `migration.ts` 模块注释）：
 * - `id` 列是默认 **BINARY** 排序规则的 TEXT；`id > ?` / `ORDER BY id` 即二进制
 *   字典序（UTF-8 字节序），键集分页不用 rowid、不用 OFFSET。
 * - 迁移状态 `io_cas_migration_state` 的游标与批计数**同事务提交**。
 */

export const MIGRATION_JOBS = ["backfill-v1", "expand-v1"] as const;
export type MigrationJob = (typeof MIGRATION_JOBS)[number];

/** 批上限（W7 ②）：行数与原文 UTF-8 字节同时封顶。 */
export const MIGRATION_BATCH_ROWS = 32;
export const MIGRATION_BATCH_BYTES = 8 * 1024 * 1024;

/** 初始速率上限（W7 ⑦）：5MiB 原文/秒。 */
export const MIGRATION_RATE_BYTES_PER_SECOND = 5 * 1024 * 1024;

/** 停止阈值（W7 ⑦）。 */
export const MIGRATION_LOCK_WAIT_P95_MS = 50;
export const MIGRATION_BUSINESS_DEGRADE_RATIO = 0.2;
export const MIGRATION_WINDOW_MS = 60_000;

/** 磁盘预留默认值；命令入口可用 `--disk-reserve-mib` 覆盖。 */
export const MIGRATION_DISK_RESERVE_BYTES = 512 * 1024 * 1024;

/** `Transaction` 与 `Database` 都满足的最小执行面。 */
export interface MigrationTx {
  get(sql: string, ...params: unknown[]): Promise<unknown>;
  all(sql: string, ...params: unknown[]): Promise<unknown[]>;
  run(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** 迁移入口：`Database` 提供事务；已是事务句柄时省略（单测可直接传 tx）。 */
export interface MigrationDatabase extends MigrationTx {
  transactionAsync?(callback: (tx: MigrationTx) => Promise<unknown>): {
    immediate(): Promise<unknown>;
    deferred(): Promise<unknown>;
  };
}

export interface CasMigrationState {
  projectId: string;
  job: MigrationJob;
  pass: number;
  cursorId: string | null;
  status: "running" | "paused" | "done" | "failed";
  scanned: number;
  converted: number;
  skipped: number;
  lastError: string | null;
}

/** 读取时快照的旧三列；写事务内必须逐字节一致（W7 ③）。 */
export interface RowSnapshot {
  input: unknown;
  codec: number;
  rawSize: unknown;
}

/** 一行的工作计划；`snapshot === null` 表示计划阶段该行已不存在。 */
export interface PlannedRow {
  id: string;
  snapshot: RowSnapshot | null;
  /** 计费字节（原文 UTF-8 字节；缺失行计 0）。 */
  bytes: number;
  /** backfill：纯准备结果；`undefined` = 降级/非候选，写事务内记 skipped。 */
  cas?: PreparedCas;
  /** expand：已核验的重组原文。 */
  text?: string;
}

export interface MigrationPlanOptions {
  projectId: string;
  job: MigrationJob;
  batchRows?: number;
  batchBytes?: number;
  /** 池块是否 deflate；与 `PERIFUSE_IO_COMPRESSION_WRITE` 一致，默认 true。 */
  compress?: boolean;
  /** 回填的纯准备缓存；省略则不缓存。 */
  cache?: CasPrepareCache;
}

export const SELECT_ROW = `SELECT input, input_codec, input_raw_size FROM observations
  WHERE project_id = ? AND id = ?`;
export const UPDATE_ROW = `UPDATE observations SET input = ?, input_codec = ?, input_raw_size = ?
  WHERE project_id = ? AND id = ?`;

/** 行级错误：携带 observation id，供失败状态定位（不记录正文）。 */
export class MigrationRowError extends Error {
  constructor(
    readonly rowId: string,
    readonly code: string,
  ) {
    super(code);
    this.name = "MigrationRowError";
  }
}

/** message 即错误码（本仓库约定）；其他一律 `IO_CAS_INVALID`。 */
export function errorCode(error: unknown): string {
  if (error instanceof MigrationRowError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) return error.message;
  return "IO_CAS_INVALID";
}

export function assertPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("IO_CAS_INVALID");
  return value as number;
}

/** 键集条件：`job` 的 codec 集合互不相交，因此两个 job 互为回退方向。 */
export function jobPredicate(job: MigrationJob): string {
  return job === "expand-v1" ? `input_codec = ${IO_CAS_CODEC}` : "input_codec IN (0, 1)";
}

export function keysetSql(job: MigrationJob): string {
  return `SELECT id FROM observations WHERE project_id = ? AND ${jobPredicate(job)}
    AND id > ? ORDER BY id COLLATE BINARY LIMIT ?`;
}

/** 短 `IMMEDIATE` 事务；`onAcquire` 收到从发起到事务体开始的等待毫秒（写锁等待）。 */
export async function immediate<T>(
  db: MigrationDatabase,
  body: (tx: MigrationTx) => Promise<T>,
  onAcquire?: (waitMs: number) => void,
): Promise<T> {
  const transaction = db.transactionAsync;
  if (typeof transaction !== "function") return body(db);
  const requested = performance.now();
  const result = await transaction
    .call(db, async (tx: MigrationTx) => {
      onAcquire?.(performance.now() - requested);
      return body(tx);
    })
    .immediate();
  return result as T;
}

/** 读事务（`BEGIN DEFERRED`）：批内行与池内容取同一快照。 */
export async function deferred<T>(
  db: MigrationDatabase,
  body: (tx: MigrationTx) => Promise<T>,
): Promise<T> {
  const transaction = db.transactionAsync;
  if (typeof transaction !== "function") return body(db);
  return (await transaction.call(db, async (tx: MigrationTx) => body(tx)).deferred()) as T;
}

/** 池查询执行面：`hydrateIoRows` 需要 `Record<string, unknown>[]` 形状。 */
export function hydrateTx(tx: MigrationTx): {
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
} {
  return {
    all: (sql, ...params) => tx.all(sql, ...params) as Promise<Record<string, unknown>[]>,
  };
}

export function equalColumn(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array || right instanceof Uint8Array)
    return (
      left instanceof Uint8Array &&
      right instanceof Uint8Array &&
      left.byteLength === right.byteLength &&
      Buffer.compare(left, right) === 0
    );
  return left === right;
}

export function snapshotOf(row: Record<string, unknown>): RowSnapshot {
  return {
    input: row.input,
    codec: Number(row.input_codec),
    rawSize: row.input_raw_size === undefined ? null : row.input_raw_size,
  };
}

export function sameSnapshot(fresh: Record<string, unknown>, snapshot: RowSnapshot): boolean {
  return (
    equalColumn(fresh.input, snapshot.input) &&
    Number(fresh.input_codec) === snapshot.codec &&
    equalColumn(fresh.input_raw_size, snapshot.rawSize)
  );
}

export function isCasCodec(codec: number): boolean {
  return codec === IO_CAS_CODEC;
}

/**
 * 从行快照解码出原文，复用读端唯一的解码器 `decodeIoRow`（不抄第二套 parser）。
 * 损坏（长度不符 / inflate 失败 / 类型错）抛 `MigrationRowError`，只带 id 不带正文。
 */
export function decodeSnapshot(snapshot: RowSnapshot, id: string): string {
  try {
    const text = decodeIoRow({
      input: snapshot.input,
      input_codec: snapshot.codec,
      input_raw_size: snapshot.rawSize,
    }).input;
    if (typeof text !== "string") throw new Error("IO_CAS_INVALID");
    return text;
  } catch (error) {
    throw new MigrationRowError(id, errorCode(error));
  }
}

/** 计费字节：优先用声明的 `input_raw_size`，缺失时退回载荷长度。 */
export function rowBytes(row: Record<string, unknown>): number {
  const declared = Number(row.input_raw_size);
  if (Number.isSafeInteger(declared) && declared > 0) return declared;
  const value = row.input;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return 0;
}

const SELECT_STATE = `SELECT project_id, job, pass, cursor_id, status, scanned, converted, skipped, last_error
  FROM io_cas_migration_state WHERE project_id = ? AND job = ?`;
const UPSERT_STATE = `INSERT INTO io_cas_migration_state
    (project_id, job, pass, cursor_id, status, scanned, converted, skipped, last_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_id, job) DO UPDATE SET
    pass = excluded.pass, cursor_id = excluded.cursor_id, status = excluded.status,
    scanned = excluded.scanned, converted = excluded.converted, skipped = excluded.skipped,
    last_error = excluded.last_error, updated_at = datetime('now')`;

export async function readMigrationState(
  db: MigrationTx,
  projectId: string,
  job: MigrationJob,
): Promise<CasMigrationState | undefined> {
  const row = (await db.get(SELECT_STATE, projectId, job)) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const counters = ["pass", "scanned", "converted", "skipped"].map((column) => Number(row[column]));
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error("IO_CAS_INVALID");
  return {
    projectId: String(row.project_id),
    job,
    pass: counters[0],
    cursorId: row.cursor_id === null || row.cursor_id === undefined ? null : String(row.cursor_id),
    status: String(row.status) as CasMigrationState["status"],
    scanned: counters[1],
    converted: counters[2],
    skipped: counters[3],
    lastError:
      row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  };
}

export async function writeMigrationState(
  tx: MigrationTx,
  state: CasMigrationState,
): Promise<void> {
  await tx.run(
    UPSERT_STATE,
    state.projectId,
    state.job,
    state.pass,
    state.cursorId,
    state.status,
    state.scanned,
    state.converted,
    state.skipped,
    state.lastError,
  );
}

export interface ResidualReport {
  /** 本次扫描到的残余 codec 0/1 行数。 */
  scanned: number;
  /** 其中**仍可转换**的行数——完成 pass 后必须为 0。 */
  candidates: number;
  /** 合法保留的非候选行数。 */
  nonCandidates: number;
  /** 无法解码的坏行。 */
  errors: { id: string; code: string }[];
  bytes: number;
  /** 是否因为行上限提前停止（`candidates` 不再是全量结论）。 */
  limited: boolean;
}

export interface VerificationReport {
  /** 已成功重组的 codec 2 根行数。 */
  rows: number;
  /** 这些根的 REF 引用总数与去重后的内容 hash 数。 */
  refs: number;
  uniqueRefs: number;
  bytes: number;
  errors: { id: string; code: string }[];
}

export interface MigrationReport {
  job: MigrationJob;
  projectId: string;
  pass: number;
  status: "done" | "paused" | "failed";
  cursorId: string | null;
  scanned: number;
  converted: number;
  skipped: number;
  batches: number;
  originalBytes: number;
  elapsedMs: number;
  bytesPerSecond: number;
  reason?: string;
  lastError?: string;
  lockWaitP95Ms?: number;
  businessP95Ms?: number;
  businessBaselineMs?: number;
  residual?: ResidualReport;
  /** backfill 结束时对全部 codec 2 根的完整重组校验。 */
  verification?: VerificationReport;
  /** expand 结束时残余的 codec 2 行数（必须为 0）。 */
  codecTwoRows?: number;
}

export function buildReport(
  state: CasMigrationState,
  extra: Partial<MigrationReport> & { status: MigrationReport["status"] },
): MigrationReport {
  return {
    job: state.job,
    projectId: state.projectId,
    pass: state.pass,
    cursorId: state.cursorId,
    scanned: state.scanned,
    converted: state.converted,
    skipped: state.skipped,
    batches: 0,
    originalBytes: 0,
    elapsedMs: 0,
    bytesPerSecond: 0,
    ...extra,
  };
}

/** 报告 → 状态行的反向映射（暂停/失败/完成时写回）。 */
export function stateOf(report: MigrationReport): CasMigrationState {
  return {
    projectId: report.projectId,
    job: report.job,
    pass: report.pass,
    cursorId: report.cursorId,
    status: report.status,
    scanned: report.scanned,
    converted: report.converted,
    skipped: report.skipped,
    lastError: report.lastError ?? null,
  };
}
