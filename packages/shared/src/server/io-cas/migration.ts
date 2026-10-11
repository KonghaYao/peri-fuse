import { encodeIoRow } from "../adapters/io-compression";
import { equalBytes, originalHash } from "./hash";
import { parseManifest } from "./manifest";
import { rescanResidualRoots, verifyCodecTwoRoots } from "./migration-audit";
import {
  assertPositiveInteger,
  buildReport,
  type CasMigrationState,
  decodeSnapshot,
  deferred,
  errorCode,
  hydrateTx,
  immediate,
  keysetSql,
  MIGRATION_BATCH_BYTES,
  MIGRATION_BATCH_ROWS,
  MIGRATION_RATE_BYTES_PER_SECOND,
  type MigrationDatabase,
  type MigrationJob,
  type MigrationPlanOptions,
  type MigrationReport,
  MigrationRowError,
  type MigrationTx,
  type PlannedRow,
  readMigrationState,
  rowBytes,
  SELECT_ROW,
  sameSnapshot,
  snapshotOf,
  stateOf,
  UPDATE_ROW,
  writeMigrationState,
} from "./migration-shared";
import {
  type MigrationStopOptions,
  MigrationStops,
  probeWriteLatency,
  RateLimiter,
} from "./migration-stops";
import { prepareCasInput } from "./prepare";
import { hydrateIoRows, IO_CAS_CODEC } from "./read";
import { publishCasInput } from "./write";

/**
 * `observations.input` 的 CAS 回填（backfill-v1）/ 回退（expand-v1）主流程（W7）。
 *
 * ## 契约
 *
 * - **游标**：`io_cas_migration_state.cursor_id` 是上一次已提交批次处理的最后一个
 *   observation id；下一批只取 `id > cursor`（二进制字典序 keyset，见
 *   `migration-shared.ts`）。批内每个 id 恰好产出一个计划行（含已删除/被并发改写的行），
 *   因此批不为空时游标必然推进，不会死循环。
 * - **批**：≤32 行且 ≤8MiB 原文字节；解码、切片、manifest/池块压缩等纯准备全部在写锁
 *   **之外**完成（W5 ①的同一条纪律）。
 * - **原子性**：写批次是单个短 `IMMEDIATE` 事务，逐行 `applyPlannedRow`：先把读取时快照的
 *   旧三列与事务内重读**逐字节比对**，不一致即跳过并计数（在线写者胜出，绝不覆盖）；
 *   一致才 `publishCasInput`（复用 W5，不另写发布/屏障）+ `UPDATE` 三列。
 *   **游标与批计数在同一事务提交**，崩溃/杀进程后从上一个已提交游标续跑（W7 ⑤）。
 * - **不动**：`event_ts` / `updated_at` / `ingestion_field_versions` / search revision /
 *   daily stats 一律不写；**不调用** `selectVersionedColumns`（它给的是布尔
 *   `input IS NOT NULL`，不能作为物理重编码依据，见 `adapters/ingestion-versions.ts`）。
 * - **失败分类**：非候选（降级）与并发不一致记 `skipped`；载荷损坏（codec 0/1 不可解码、
 *   长度不符、manifest 不可重组、原文不可重编码）记 `failed` 并暂停，
 *   `last_error = <错误码>@<id>`，游标不前移（`--cursor` 可越过坏行）。
 * - **expand-v1**：只处理 `input_codec = 2` 的行，在同一 deferred 读事务内用
 *   `hydrateIoRows` 组装原文并核验 `original_hash` + `input_raw_size`，再按既有 codec 0/1
 *   规则重新编码写回；结束条件是 `codec 2` 计数归零。
 * - **引擎门禁**：本模块不做能力判定，**命令入口必须先调用**
 *   `assertReadSnapshotSupported(db)`（W1）：不能证明读快照能力的引擎禁止产生 codec 2。
 */

export interface MigrationProgress {
  batches: number;
  scanned: number;
  converted: number;
  skipped: number;
  cursorId: string | null;
  bytesPerSecond: number;
  lockWaitP95Ms?: number;
  businessP95Ms?: number;
}

export interface CasMigrationOptions extends MigrationPlanOptions {
  pass?: number;
  /** 从状态行游标续跑；否则要求不存在未完成状态。 */
  resume?: boolean;
  /** 覆盖起点/续跑游标（越过坏行的运维逃生口）。 */
  cursor?: string | null;
  rateBytesPerSecond?: number;
  stops?: MigrationStopOptions;
  /** 结束后做残余重扫 + codec 2 完整校验（默认 true）。 */
  verify?: boolean;
  /** 残余重扫行上限；省略 = 不限。 */
  rescanRows?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: MigrationProgress) => void;
}

function planBudget(options: MigrationPlanOptions): { batchRows: number; batchBytes: number } {
  return {
    batchRows: assertPositiveInteger(options.batchRows, MIGRATION_BATCH_ROWS),
    batchBytes: assertPositiveInteger(options.batchBytes, MIGRATION_BATCH_BYTES),
  };
}

/** 单行计划：backfill 只做解码 + 纯准备；expand 在同一读事务内装配并核验。 */
async function planBackfillRow(
  tx: MigrationTx,
  options: MigrationPlanOptions,
  id: string,
): Promise<PlannedRow> {
  const row = (await tx.get(SELECT_ROW, options.projectId, id)) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { id, snapshot: null, bytes: 0 };
  const snapshot = snapshotOf(row);
  const bytes = rowBytes(row);
  if (snapshot.codec !== 0 && snapshot.codec !== 1) return { id, snapshot, bytes };
  if (snapshot.input === null || snapshot.input === undefined) return { id, snapshot, bytes };
  const text = decodeSnapshot(snapshot, id);
  const cas = prepareCasInput(text, {
    projectId: options.projectId,
    cache: options.cache,
    compress: options.compress !== false,
  });
  return { id, snapshot, bytes, cas };
}

async function planExpandRow(
  tx: MigrationTx,
  options: MigrationPlanOptions,
  id: string,
): Promise<PlannedRow> {
  const row = (await tx.get(SELECT_ROW, options.projectId, id)) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { id, snapshot: null, bytes: 0 };
  const snapshot = snapshotOf(row);
  const bytes = rowBytes(row);
  if (snapshot.codec !== IO_CAS_CODEC) return { id, snapshot, bytes };
  const manifest = snapshot.input;
  if (!(manifest instanceof Uint8Array)) throw new MigrationRowError(id, "IO_CAS_INVALID");
  const target: Record<string, unknown> = { ...row, project_id: options.projectId };
  // 单行装配用默认预算（= 格式上限 32MiB）：一个行的原文/ manifest 各自 ≤32MiB。
  await hydrateIoRows(hydrateTx(tx), [target]);
  const text = target.input;
  if (typeof text !== "string") throw new MigrationRowError(id, "IO_CAS_INVALID");
  const bytes8 = Buffer.from(text, "utf8");
  const declared = Number(snapshot.rawSize);
  // 逐字节一致的显式证据：UTF-8 往返长度 + 独立的 original_hash 复算。
  if (!Number.isSafeInteger(declared) || bytes8.byteLength !== declared)
    throw new MigrationRowError(id, "IO_CAS_CORRUPT");
  if (!equalBytes(originalHash(bytes8), parseManifest(manifest).originalHash))
    throw new MigrationRowError(id, "IO_CAS_CORRUPT");
  return { id, snapshot, bytes, text };
}

/**
 * 计划一批：keyset 取 id → 逐行纯准备。expand 的计划（行读取 + 池装配）在**同一个
 * deferred 读事务**内完成，保证行与池内容来自同一快照；backfill 不需要装配，
 * 直接在当前执行面上读（写事务内还会逐字节复核）。
 */
export async function planMigrationBatch(
  db: MigrationDatabase,
  options: MigrationPlanOptions,
  cursor: string | null,
): Promise<PlannedRow[]> {
  const budget = planBudget(options);
  const ids = (
    (await db.all(keysetSql(options.job), options.projectId, cursor ?? "", budget.batchRows)) as {
      id?: unknown;
    }[]
  ).filter((row) => typeof row.id === "string");
  if (ids.length === 0) return [];
  const planOne = options.job === "expand-v1" ? planExpandRow : planBackfillRow;
  return deferred(db, async (tx) => {
    const planned: PlannedRow[] = [];
    let bytes = 0;
    for (const candidate of ids) {
      const id = String(candidate.id);
      let row: PlannedRow;
      try {
        row = await planOne(tx, options, id);
      } catch (error) {
        // 计划期错误（解码失败、manifest 不可重组）同样带 id 进失败状态。
        throw error instanceof MigrationRowError
          ? error
          : new MigrationRowError(id, errorCode(error));
      }
      if (planned.length > 0 && bytes + row.bytes > budget.batchBytes) break;
      planned.push(row);
      bytes += row.bytes;
    }
    return planned;
  });
}

/**
 * 写事务内应用一行（W7 ③④）：重读旧三列并与计划快照逐字节比对，不一致即跳过；
 * 一致才发布池内容（W5 `publishCasInput`，含写屏障）并更新三列。
 *
 * 同一 `IMMEDIATE` 事务内 `SELECT` → `UPDATE` 之间不存在并发写者（单写锁），
 * 因此这个比对就是「无更新覆盖」的全部依据，UPDATE 无需再带旧值条件。
 */
export async function applyPlannedRow(
  tx: MigrationTx,
  options: { projectId: string; job: MigrationJob; compress: boolean },
  planned: PlannedRow,
): Promise<"converted" | "skipped"> {
  const fresh = (await tx.get(SELECT_ROW, options.projectId, planned.id)) as
    | Record<string, unknown>
    | undefined;
  if (!fresh || !planned.snapshot || !sameSnapshot(fresh, planned.snapshot)) return "skipped";
  if (options.job === "backfill-v1") {
    const cas = planned.cas;
    if (!cas) return "skipped";
    await publishCasInput(tx, options.projectId, cas);
    await tx.run(
      UPDATE_ROW,
      cas.manifest,
      IO_CAS_CODEC,
      cas.rawSize,
      options.projectId,
      planned.id,
    );
    return "converted";
  }
  if (typeof planned.text !== "string") return "skipped";
  const encoded = encodeIoRow("observations", { input: planned.text }, options.compress);
  await tx.run(
    UPDATE_ROW,
    encoded.input,
    encoded.input_codec,
    encoded.input_raw_size,
    options.projectId,
    planned.id,
  );
  return "converted";
}

async function beginMigration(
  db: MigrationDatabase,
  options: CasMigrationOptions,
): Promise<CasMigrationState> {
  const existing = await readMigrationState(db, options.projectId, options.job);
  if (options.resume) {
    if (!existing) throw new Error("IO_CAS_MIGRATION_MISSING");
    if (options.pass !== undefined && options.pass !== existing.pass)
      throw new Error("IO_CAS_MIGRATION_PASS");
    return {
      ...existing,
      cursorId: options.cursor !== undefined ? options.cursor : existing.cursorId,
    };
  }
  const pass = options.pass ?? existing?.pass ?? 1;
  if (existing && existing.status !== "done") throw new Error("IO_CAS_MIGRATION_IN_PROGRESS");
  if (existing && existing.pass === pass) throw new Error("IO_CAS_MIGRATION_DONE");
  const state: CasMigrationState = {
    projectId: options.projectId,
    job: options.job,
    pass,
    cursorId: options.cursor ?? null,
    status: "running",
    scanned: 0,
    converted: 0,
    skipped: 0,
    lastError: null,
  };
  await immediate(db, (tx) => writeMigrationState(tx, state));
  return state;
}

/** 独立的短事务只写状态行（暂停/失败/完成），不动业务数据。 */
async function persist(
  db: MigrationDatabase,
  state: CasMigrationState,
  patch: Partial<CasMigrationState>,
): Promise<void> {
  await immediate(db, (tx) => writeMigrationState(tx, { ...state, ...patch }));
}

/**
 * 执行一次迁移。返回报告，状态行始终反映最终状态（done / paused / failed）。
 * 调用方必须先完成引擎门禁（`assertReadSnapshotSupported`）与 schema 存在性检查。
 */
export async function runCasMigration(
  db: MigrationDatabase,
  options: CasMigrationOptions,
): Promise<MigrationReport> {
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  const budget = planBudget(options);
  const planOptions: MigrationPlanOptions = { ...options, ...budget };
  const applyOptions = {
    projectId: options.projectId,
    job: options.job,
    compress: options.compress !== false,
  };
  const state = await beginMigration(db, options);
  const stops = new MigrationStops({ ...options.stops, now });
  const rate = options.rateBytesPerSecond ?? MIGRATION_RATE_BYTES_PER_SECOND;
  if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error("IO_CAS_INVALID");
  const limiter = new RateLimiter(rate, now, sleep);
  const startedAt = now();
  let batches = 0;
  let originalBytes = 0;

  const finish = async (
    status: MigrationReport["status"],
    extra: Partial<MigrationReport>,
  ): Promise<MigrationReport> => {
    const elapsedMs = now() - startedAt;
    return buildReport(state, {
      status,
      batches,
      originalBytes,
      elapsedMs,
      bytesPerSecond: elapsedMs > 0 ? (originalBytes / elapsedMs) * 1000 : 0,
      lockWaitP95Ms: stops.lockWaitP95Ms,
      businessP95Ms: stops.businessP95Ms,
      businessBaselineMs: stops.businessBaselineMs,
      ...extra,
    });
  };

  for (;;) {
    const reason = stops.reason();
    if (reason) {
      await persist(db, state, { status: "paused" });
      return finish("paused", { reason });
    }
    let planned: PlannedRow[];
    try {
      planned = await planMigrationBatch(db, planOptions, state.cursorId);
    } catch (error) {
      const code = errorCode(error);
      const lastError =
        error instanceof MigrationRowError ? `${code}@${error.rowId}` : String(code);
      await persist(db, state, { status: "failed", lastError });
      return finish("failed", { lastError, reason: code });
    }
    if (planned.length === 0) break;

    let waitMs = 0;
    let failingId: string | undefined;
    let converted = 0;
    let skipped = 0;
    const cursorId = planned[planned.length - 1].id;
    const batchBytes = planned.reduce((total, row) => total + row.bytes, 0);
    try {
      await immediate(
        db,
        async (tx) => {
          for (const row of planned) {
            failingId = row.id;
            if ((await applyPlannedRow(tx, applyOptions, row)) === "converted") converted++;
            else skipped++;
          }
          // W7 ⑤：游标与批结果同事务提交；崩溃后从上一个已提交游标续跑。
          await writeMigrationState(tx, {
            ...state,
            cursorId,
            status: "running",
            scanned: state.scanned + planned.length,
            converted: state.converted + converted,
            skipped: state.skipped + skipped,
            lastError: null,
          });
        },
        (wait) => {
          waitMs = wait;
        },
      );
    } catch (error) {
      const code = errorCode(error);
      const lastError = failingId ? `${code}@${failingId}` : String(code);
      // 整批回滚：计数与游标停在上一个已提交值；损坏行记 failed 并暂停（W7 ⑥）。
      await persist(db, state, { status: "failed", lastError });
      return finish("failed", { lastError, reason: code });
    }
    state.cursorId = cursorId;
    state.scanned += planned.length;
    state.converted += converted;
    state.skipped += skipped;
    batches++;
    originalBytes += batchBytes;
    stops.record({ lockWaitMs: waitMs, businessMs: await probeWriteLatency(db) });
    options.onProgress?.({
      batches,
      scanned: state.scanned,
      converted: state.converted,
      skipped: state.skipped,
      cursorId,
      bytesPerSecond: (originalBytes / Math.max(1, now() - startedAt)) * 1000,
      lockWaitP95Ms: stops.lockWaitP95Ms,
      businessP95Ms: stops.businessP95Ms,
    });
    await limiter.pace(batchBytes);
  }

  await persist(db, state, { status: "done", lastError: null });
  const finished = await finish("done", {});
  return options.verify === false ? finished : finalizeMigration(db, finished, options.rescanRows);
}

/**
 * 结束校验（W7 ⑥⑨）：backfill 重扫残余 + 全部 codec 2 根完整重组；expand 要求 codec 2
 * 计数归零。任一项不通过即把状态行改为 `failed` 并附证据。
 */
export async function finalizeMigration(
  db: MigrationDatabase,
  finished: MigrationReport,
  rescanRows?: number,
): Promise<MigrationReport> {
  if (finished.job === "expand-v1") {
    const row = (await db.get(
      `SELECT COUNT(*) AS count FROM observations WHERE project_id = ? AND input_codec = ${IO_CAS_CODEC}`,
      finished.projectId,
    )) as { count?: unknown } | undefined;
    const codecTwoRows = Number(row?.count ?? 0);
    if (codecTwoRows === 0) return { ...finished, codecTwoRows };
    const lastError = `IO_CAS_RESIDUAL_CODEC2@${codecTwoRows}`;
    await persist(db, stateOf(finished), { status: "failed", lastError });
    return {
      ...finished,
      status: "failed",
      codecTwoRows,
      lastError,
      reason: "IO_CAS_RESIDUAL_CODEC2",
    };
  }
  const residual = await rescanResidualRoots(db, {
    projectId: finished.projectId,
    limit: rescanRows,
  });
  const verification = await verifyCodecTwoRoots(db, { projectId: finished.projectId });
  const failed =
    residual.candidates > 0 || residual.errors.length > 0 || verification.errors.length > 0;
  if (!failed) return { ...finished, residual, verification };
  const lastError = `IO_CAS_RESIDUAL@${residual.candidates}`;
  await persist(db, stateOf(finished), { status: "failed", lastError });
  return {
    ...finished,
    status: "failed",
    residual,
    verification,
    lastError,
    reason: "IO_CAS_RESIDUAL",
  };
}
