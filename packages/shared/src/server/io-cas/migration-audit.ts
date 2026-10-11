import { deflateSync } from "node:zlib";
import { encodeIoRow } from "../adapters/io-compression";
import { planJsonSlices } from "./json-slices";
import { collectRefHashes, parseManifest } from "./manifest";
import {
  assertPositiveInteger,
  decodeSnapshot,
  deferred,
  errorCode,
  hydrateTx,
  isCasCodec,
  keysetSql,
  MIGRATION_BATCH_ROWS,
  type MigrationDatabase,
  MigrationRowError,
  type ResidualReport,
  rowBytes,
  SELECT_ROW,
  snapshotOf,
  type VerificationReport,
} from "./migration-shared";
import { prepareCasInput } from "./prepare";
import { hydrateIoRows, IO_CAS_CODEC } from "./read";

/**
 * W7 的审计面：dry-run 统计、pass 后的残余重扫、codec 2 根的完整重组校验。
 * 三者的共同纪律：**只读**、按 keyset 分页、不做任何写入，报告里的字节口径全部是
 * 原文/载荷字节（不复用语义指纹率）。
 */

export interface DryRunReport {
  projectId: string;
  sampledRows: number;
  /** 项目内匹配 codec 0/1 的行总数（`COUNT(*)`，非外推）。 */
  projectRows: number;
  extrapolated: boolean;
  scale: number;
  totalBytes: number;
  candidateRows: number;
  candidateBytes: number;
  nonCandidateRows: number;
  sampledErrors: number;
  codecZeroRows: number;
  codecOneRows: number;
  /** 字节口径：REF 字节 / 原文字节 = 可切分覆盖率。 */
  refBytes: number;
  literalBytes: number;
  manifestBytes: number;
  /** 去重后 REF 字节 = 原始切片唯一率 × REF 字节。 */
  uniqueRefBytes: number;
  uniqueChunks: number;
  /** 池与 manifest 的预计存储字节（池块按压缩开关的收益门槛）。 */
  poolStoredBytes: number;
  projectedStoredBytes: number;
  /** 既有 codec 1 写入策略下的存储字节（基线）。 */
  baselineStoredBytes: number;
  compress: boolean;
  /** 索引成本估算（口径见函数注释）。 */
  estimatedRootIndexBytes: number;
  estimatedPoolIndexBytes: number;
}

const SAMPLE_BATCH_ROWS = MIGRATION_BATCH_ROWS;

async function selectIds(
  db: MigrationDatabase,
  job: "backfill-v1" | "expand-v1",
  projectId: string,
  cursor: string | null,
  limit = SAMPLE_BATCH_ROWS,
): Promise<string[]> {
  const rows = (await db.all(keysetSql(job), projectId, cursor ?? "", limit)) as { id?: unknown }[];
  return rows.filter((row) => typeof row.id === "string").map((row) => String(row.id));
}

/**
 * pass 后重扫残余 codec 0/1 行（W7 ⑥）。`candidates` 是「此刻仍会转换」的行数，
 * 完成 pass 后必须为 0；其余 codec 0/1 行是合法的非候选（<16KiB、非 messages 形态等），
 * 会被持续报告但不需要二次迁移。
 */
export async function rescanResidualRoots(
  db: MigrationDatabase,
  options: { projectId: string; limit?: number; batchRows?: number; compress?: boolean },
): Promise<ResidualReport> {
  const report: ResidualReport = {
    scanned: 0,
    candidates: 0,
    nonCandidates: 0,
    errors: [],
    bytes: 0,
    limited: false,
  };
  let cursor: string | null = null;
  for (;;) {
    const ids = await selectIds(db, "backfill-v1", options.projectId, cursor, options.batchRows);
    if (ids.length === 0) return report;
    for (const id of ids) {
      if (options.limit !== undefined && report.scanned >= options.limit) {
        report.limited = true;
        return report;
      }
      report.scanned++;
      const row = (await db.get(SELECT_ROW, options.projectId, id)) as
        | Record<string, unknown>
        | undefined;
      if (!row) continue;
      report.bytes += rowBytes(row);
      const snapshot = snapshotOf(row);
      const decodable =
        (snapshot.codec === 0 || snapshot.codec === 1) &&
        snapshot.input !== null &&
        snapshot.input !== undefined;
      if (!decodable) {
        report.nonCandidates++;
        continue;
      }
      try {
        const text = decodeSnapshot(snapshot, id);
        const cas = prepareCasInput(text, {
          projectId: options.projectId,
          compress: options.compress !== false,
        });
        if (cas) report.candidates++;
        else report.nonCandidates++;
      } catch (error) {
        report.errors.push({ id, code: errorCode(error) });
      }
    }
    cursor = ids[ids.length - 1];
  }
}

/**
 * codec 2 根的完整校验（W7 ⑨）：逐批在同一 deferred 读事务内调用 `hydrateIoRows`
 * 重组（端到端 `original_hash` 校验），只计数、不留正文。REF 统计需要额外解析一次
 * manifest（不解压 body 之外的额外 IO），用于报告「引用全部可重组」的规模。
 */
export async function verifyCodecTwoRoots(
  db: MigrationDatabase,
  options: { projectId: string; batchRows?: number },
): Promise<VerificationReport> {
  const report: VerificationReport = { rows: 0, refs: 0, uniqueRefs: 0, bytes: 0, errors: [] };
  const hexes = new Set<string>();
  const batchRows = assertPositiveInteger(options.batchRows, MIGRATION_BATCH_ROWS);
  let cursor: string | null = null;
  for (;;) {
    const ids = await selectIds(db, "expand-v1", options.projectId, cursor, batchRows);
    if (ids.length === 0) return report;
    cursor = ids[ids.length - 1];
    try {
      await deferred(db, async (tx) => {
        const targets: Record<string, unknown>[] = [];
        let bytes = 0;
        for (const id of ids) {
          const row = (await tx.get(SELECT_ROW, options.projectId, id)) as
            | Record<string, unknown>
            | undefined;
          if (!row || !isCasCodec(Number(row.input_codec))) continue;
          const manifest = row.input;
          if (!(manifest instanceof Uint8Array)) throw new MigrationRowError(id, "IO_CAS_INVALID");
          for (const key of collectRefHashes(parseManifest(manifest))) {
            report.refs++;
            hexes.add(key.hex);
          }
          bytes += rowBytes(row);
          targets.push({ ...row, id, project_id: options.projectId });
        }
        if (targets.length === 0) return;
        const hydrated = await hydrateIoRows(hydrateTx(tx), targets);
        report.rows += hydrated.length;
        report.bytes += bytes;
      });
    } catch (error) {
      report.errors.push({ id: cursor, code: errorCode(error) });
      report.uniqueRefs = hexes.size;
      return report;
    }
    report.uniqueRefs = hexes.size;
  }
}

/** expand 前的只读规模统计（不做行装配，装配成本在 pass 内）。 */
export async function expandPreflight(
  db: MigrationDatabase,
  projectId: string,
): Promise<{ rows: number; storedBytes: number; originalBytes: number }> {
  const row = (await db.get(
    `SELECT COUNT(*) AS rows,
       COALESCE(SUM(LENGTH(input)), 0) AS storedBytes,
       COALESCE(SUM(input_raw_size), 0) AS originalBytes
     FROM observations WHERE project_id = ? AND input_codec = ${IO_CAS_CODEC}`,
    projectId,
  )) as Record<string, unknown> | undefined;
  return {
    rows: Number(row?.rows ?? 0),
    storedBytes: Number(row?.storedBytes ?? 0),
    originalBytes: Number(row?.originalBytes ?? 0),
  };
}

/**
 * dry-run 统计（W7 ①）：抽样 ≤`limit` 行 codec 0/1，输出**字节口径**的收益证据。
 *
 * - 可切分覆盖率 = `refBytes / totalBytes`；原始切片唯一率 = `uniqueRefBytes / refBytes`。
 * - `baselineStoredBytes`：既有写入策略（≥1KiB 且 deflate+16B 更小才压）逐行存储字节。
 * - `projectedStoredBytes`：`manifestBytes + poolStoredBytes`（池块按同一压缩门槛估算，
 *   同 hash 只计一次）。
 * - `estimatedRootIndexBytes` = 预计转换行数 × 84B（id + project + codec + 行指针的
 *   保守估计）；`estimatedPoolIndexBytes` = 池行数 × 64B。两者都是**量级估算**，
 *   不是 SQLite 页级的精确值。
 * - 样本外不足全量时按 `projectRows / sampledRows` 线性外推并置 `extrapolated`。
 */
export async function dryRunCasMigration(
  db: MigrationDatabase,
  options: { projectId: string; limit?: number; compress?: boolean },
): Promise<DryRunReport> {
  const compress = options.compress !== false;
  const limit = options.limit ?? 2000;
  const report: DryRunReport = {
    projectId: options.projectId,
    sampledRows: 0,
    projectRows: 0,
    extrapolated: false,
    scale: 1,
    totalBytes: 0,
    candidateRows: 0,
    candidateBytes: 0,
    nonCandidateRows: 0,
    sampledErrors: 0,
    codecZeroRows: 0,
    codecOneRows: 0,
    refBytes: 0,
    literalBytes: 0,
    manifestBytes: 0,
    uniqueRefBytes: 0,
    uniqueChunks: 0,
    poolStoredBytes: 0,
    projectedStoredBytes: 0,
    baselineStoredBytes: 0,
    compress,
    estimatedRootIndexBytes: 0,
    estimatedPoolIndexBytes: 0,
  };
  const count = (await db.get(
    "SELECT COUNT(*) AS count FROM observations WHERE project_id = ? AND input_codec IN (0, 1)",
    options.projectId,
  )) as { count?: unknown } | undefined;
  report.projectRows = Number(count?.count ?? 0);
  const chunks = new Map<string, { raw: number; stored: number }>();
  let cursor: string | null = null;
  while (report.sampledRows < limit) {
    const ids = await selectIds(db, "backfill-v1", options.projectId, cursor);
    if (ids.length === 0) break;
    for (const id of ids) {
      if (report.sampledRows >= limit) break;
      cursor = id;
      report.sampledRows++;
      const row = (await db.get(SELECT_ROW, options.projectId, id)) as
        | Record<string, unknown>
        | undefined;
      if (!row) continue;
      const snapshot = snapshotOf(row);
      report.totalBytes += rowBytes(row);
      if (snapshot.codec === 0) report.codecZeroRows++;
      if (snapshot.codec === 1) report.codecOneRows++;
      if (snapshot.input === null || snapshot.input === undefined) {
        report.nonCandidateRows++;
        continue;
      }
      let text: string;
      try {
        text = decodeSnapshot(snapshot, id);
      } catch {
        report.sampledErrors++;
        continue;
      }
      const baseline = encodeIoRow("observations", { input: text }, compress);
      report.baselineStoredBytes +=
        baseline.input_codec === 1
          ? (baseline.input as Uint8Array).byteLength
          : Buffer.byteLength(text, "utf8");
      const planned = planJsonSlices(text);
      if (planned.status !== "ok") {
        report.nonCandidateRows++;
        continue;
      }
      const plan = planned.plan;
      report.candidateRows++;
      report.candidateBytes += plan.bytes.byteLength;
      report.manifestBytes += plan.manifestBytes;
      for (const range of plan.literals) report.literalBytes += range.end - range.start;
      for (const ref of plan.refs) {
        const size = ref.end - ref.start;
        report.refBytes += size;
        const hex = Buffer.from(ref.hash).toString("hex");
        if (chunks.has(hex)) continue;
        const raw = plan.bytes.subarray(ref.start, ref.end);
        const deflated = compress ? deflateSync(raw).byteLength : undefined;
        chunks.set(hex, {
          raw: raw.byteLength,
          stored:
            deflated !== undefined && deflated + 16 < raw.byteLength ? deflated : raw.byteLength,
        });
      }
    }
  }
  let uniqueRawBytes = 0;
  for (const chunk of chunks.values()) {
    report.poolStoredBytes += chunk.stored;
    uniqueRawBytes += chunk.raw;
  }
  report.uniqueRefBytes = uniqueRawBytes;
  report.uniqueChunks = chunks.size;
  const scale =
    report.sampledRows > 0 && report.projectRows > report.sampledRows
      ? report.projectRows / report.sampledRows
      : 1;
  report.scale = scale;
  report.extrapolated = scale > 1;
  if (scale > 1) {
    for (const key of [
      "totalBytes",
      "candidateRows",
      "candidateBytes",
      "nonCandidateRows",
      "sampledErrors",
      "codecZeroRows",
      "codecOneRows",
      "refBytes",
      "literalBytes",
      "manifestBytes",
      "uniqueRefBytes",
      "poolStoredBytes",
      "baselineStoredBytes",
    ] as const)
      report[key] = Math.round(report[key] * scale);
    report.uniqueChunks = Math.round(report.uniqueChunks * scale);
  }
  report.projectedStoredBytes = report.manifestBytes + report.poolStoredBytes;
  report.estimatedRootIndexBytes = Math.round(report.candidateRows * 84);
  report.estimatedPoolIndexBytes = Math.round(report.uniqueChunks * 64);
  return report;
}
