import type { LocalExecutor } from "../../db/local";
import { type CasPrepareCache, type PreparedCas, prepareCasInput } from "../io-cas/prepare";
import { IO_CAS_CODEC } from "../io-cas/read";
import { publishCasInput } from "../io-cas/write";
import { encodeIoRow, ioColumns } from "./io-compression";

/**
 * IO 三列（`input` / `input_codec` / `input_raw_size`，以及 output 组）在写入路径上的
 * **决策层**（D-6 定案）。本模块把三件事从 `sqlite-telemetry-adapter.ts` 的 SQL 语句
 * 构造中抽出来，保证"编码 → 是否胜出 → 是否发布 CAS"只有一处实现：
 *
 * 1. `prepareIoColumns`：**纯准备**（W5 ①），可在写锁之前执行。CAS off 时它逐字节等价于
 *    既有的 `encodeIoRow(table, row, compress)`；CAS on 且 input 满足切片阈值时，input 三列
 *    改为 `(manifest, codec 2, rawSize)`，output 仍走既有编码。
 * 2. `publishIoColumnsIfWinner`：**只在 input 最终胜出时**发布池内容与写屏障（W5 ③），
 *    与调用方的行写入同事务。未胜出时对池 0 次查询。
 * 3. `casWriteEnabledFor`：`PERIFUSE_IO_CAS_WRITE` / `PERIFUSE_IO_CAS_PROJECTS` 的项目级开关。
 *
 * ## 胜出判定表（写路径边界行为，逐行落成测试）
 *
 * | # | 路径 | 输入 | 现有行 | 显式更新列 | 版本决策 | inherit(input) | 结果 |
 * | --- | --- | --- | --- | --- | --- | --- | --- |
 * | B1 | insert | 候选 | 无 | 任意 | 任意 | 任意 | 写 codec 2 三列 + 发布 |
 * | B2 | insert | 候选 | 有 | 无（`INSERT OR REPLACE`） | — | — | 整体替换为 codec 2 + 发布 |
 * | B3 | insert | 候选 | 有 | 含 input | 有 | — | accepted 含 input → 发布；被版本拒绝 → 不写不发布 |
 * | B4 | insert | 候选 | 有 | 含 input | 无 | — | requested 含 input → 发布 |
 * | B5 | insert | 候选 | 有 | 不含 input | 有 | input | accepted 含 input（仅旧值缺失时）→ 发布；否则不发布 |
 * | B6 | insert | 候选 | 有 | 不含 input | 无 | input | SQL CASE 分支：旧行 `codec=0 且 input IS NULL` → 写入并发布；否则保留旧值、不发布 |
 * | B7 | insert | 候选 | 有 | 不含 input | — | 无 | 三列都不在 UPDATE 集 → 不发布 |
 * | B8 | insert | 非候选（<16KiB / 降级 / 非 string / null） | 任意 | 任意 | 任意 | 任意 | 池 0 次查询；codec 0/1 与现状逐字节一致 |
 * | B9 | merge | 候选 | 无 | — | — | — | 插入 codec 2 + 发布 |
 * | B10 | merge | 候选 | 有 | — | — | — | `excluded.input IS NOT NULL` → 覆盖为 codec 2 + 发布 |
 * | B11 | merge | null / 未提供 | 有 | — | — | — | 三列保持旧值 → 不发布（旧值 codec 2 = manifest 原样继承，无需屏障） |
 * | B12 | 任意 | output-only / summary 写（无 input 键） | — | — | — | — | 池 0 次查询 |
 * | B13 | `traces` | 候选形态 | 任意 | 任意 | 任意 | 任意 | 永不 CAS（codec 2 在 traces 非法）→ codec 0/1 |
 * | B14 | 任意 | 任意 | 任意 | 任意 | 任意 | 任意 | CAS off（默认）：无 CAS 代码参与，池 0 次查询 |
 * | B15 | 任意 | 候选 | 任意 | 任意 | 任意 | 任意 | 项目不在 allowlist → codec 0/1，池 0 次查询 |
 * | B16 | 任意 | 候选 | — | — | — | — | 池已有同 hash 且一致 → 只发布引用 |
 * | B17 | 任意 | 候选 | — | — | — | — | 池同 hash 不一致 → 重读核验一次，仍不符抛 `IO_CAS_CORRUPT`（事务回滚） |
 * | B18 | 任意 | 候选 | — | — | — | — | 池缺块 → 补插（只忽略该唯一键冲突） |
 * | B19 | 任意 | 候选 + phase∈{mark,sweep} | — | — | — | — | 发布后 `markReferenced` 只更新旧 epoch 行 |
 * | B20 | 任意 | 候选 + phase∉{mark,sweep} | — | — | — | — | 屏障 0 次 UPDATE |
 * | B21 | 任意 | inherit 到既有 codec 2 行 | 有 codec 2 | — | — | — | 三列与引用都不变 → 不插池、不写屏障（理由见报告） |
 */

/** CAS 写入开关（adapter 构造期读取一次，见 D-15）。 */
export interface CasWriteConfig {
  enabled: boolean;
  /** `null` = 全部项目；否则为 allowlist。 */
  projects: ReadonlySet<string> | null;
}

/**
 * 解析 `PERIFUSE_IO_CAS_WRITE`（`off|on`，默认 off）与 `PERIFUSE_IO_CAS_PROJECTS`
 * （逗号分隔；空或全空白 = 全部项目）。非法值抛 `IO_CAS_INVALID_CONFIG`，
 * 与既有 `PERIFUSE_IO_COMPRESSION_WRITE` 的构造期校验一致（不回显原值）。
 */
export function resolveCasWriteConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CasWriteConfig {
  const write = environment.PERIFUSE_IO_CAS_WRITE;
  if (write !== undefined && write !== "off" && write !== "on")
    throw new Error("IO_CAS_INVALID_CONFIG");
  const projects = (environment.PERIFUSE_IO_CAS_PROJECTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return { enabled: write === "on", projects: projects.length > 0 ? new Set(projects) : null };
}

export function casWriteEnabledFor(config: CasWriteConfig, projectId: unknown): boolean {
  if (!config.enabled) return false;
  if (config.projects === null) return true;
  return typeof projectId === "string" && config.projects.has(projectId);
}

export interface PreparedIoColumns {
  /** 参与 INSERT 的列；IO 三列始终成组出现（`ioColumns` 联动）。 */
  encoded: Record<string, unknown>;
  /** 只有 input 最终胜出时才发布（W5 ③）；codec 0/1 或降级时为 undefined。 */
  cas?: PreparedCas;
}

export interface PrepareIoColumnsOptions {
  /** `PERIFUSE_IO_COMPRESSION_WRITE`，同时决定池块是否 deflate。 */
  compress: boolean;
  cas: CasWriteConfig;
  /** 单次调用缓存（省略则不缓存）。 */
  cache?: CasPrepareCache;
}

/**
 * 纯准备：编码一行（含 CAS 候选）。不访问数据库，可在写锁之前批量执行（W5 ①）。
 *
 * 注意 `encodeIoRow` 的三列联动不会被拆散：CAS 候选时先把 `input` 从待编码行中取出，
 * 再补齐 `(input, input_codec, input_raw_size)` 三列，因此这三列要么整体是 codec 2，
 * 要么整体走既有 codec 0/1 编码。
 */
export function prepareIoColumns(
  table: string,
  row: Record<string, unknown>,
  options: PrepareIoColumnsOptions,
): PreparedIoColumns {
  const input = row.input;
  // codec 2 在 traces / output 上是非法上下文，且项目必须在 allowlist 内。
  if (
    table !== "observations" ||
    typeof input !== "string" ||
    !casWriteEnabledFor(options.cas, row.project_id)
  ) {
    return { encoded: encodeIoRow(table, row, options.compress) };
  }
  const cas = prepareCasInput(input, {
    projectId: String(row.project_id),
    cache: options.cache,
    compress: options.compress,
  });
  if (!cas) return { encoded: encodeIoRow(table, row, options.compress) };
  const { input: _input, ...rest } = row;
  const encoded = encodeIoRow(table, rest, options.compress);
  // 三列由 `ioColumns` 成组给出：任何组定义变化都会同时反映到编码与冲突子句。
  const [value, codecColumn, sizeColumn] = ioColumns(table, "input");
  encoded[value] = cas.manifest;
  encoded[codecColumn] = IO_CAS_CODEC;
  encoded[sizeColumn] = cas.rawSize;
  return { encoded, cas };
}

export interface CasPublishArgs {
  mode: "insert" | "merge";
  table: string;
  rowId: string;
  projectId: string;
  prepared: PreparedIoColumns;
  /** insert 路径过滤后的显式更新列；`undefined` = `INSERT OR REPLACE`。 */
  requested?: readonly string[];
  /** 版本决策胜出列（insert + eventIds）；`undefined` = 未走版本决策。 */
  accepted?: readonly string[];
  /** 目标行是否已存在。 */
  rowExists: boolean;
  /** 该记录是否可能在 SQL CASE 分支里写入 `input`。 */
  inheritInput: boolean;
}

/**
 * ③ 的单一实现：判定 input 是否最终胜出，胜出则在同事务内发布池内容 + 写屏障。
 *
 * 未胜出（或本行没有 CAS 候选）时对 `io_cas_chunks` / `io_cas_gc_state` **0 次查询**。
 */
export async function publishIoColumnsIfWinner(
  tx: LocalExecutor,
  args: CasPublishArgs,
): Promise<PreparedCas | undefined> {
  const cas = args.prepared.cas;
  if (!cas) return undefined;
  if (!(await winsInput(tx, args))) return undefined;
  await publishCasInput(tx, args.projectId, cas);
  return cas;
}

async function winsInput(tx: LocalExecutor, args: CasPublishArgs): Promise<boolean> {
  // merge：`CASE WHEN excluded.input IS NOT NULL THEN excluded.input ELSE …`，候选必然非空。
  if (args.mode === "merge") return true;
  // `INSERT OR REPLACE`：整行替换，input 必然写为新值。
  if (args.requested === undefined) return true;
  // 目标行不存在：INSERT 写入全部编码列。
  if (!args.rowExists) return true;
  const winners = args.accepted ?? args.requested;
  if (winners.includes("input")) return true;
  if (!args.inheritInput) return false;
  // 版本决策存在时，inherit 只会以 accepted 的形式写入，未被接受即不会写 input。
  if (args.accepted !== undefined) return false;
  // SQL CASE 分支：`WHEN observations.input_codec=0 AND observations.input IS NULL THEN excluded.input`。
  const existing = (await tx.get(
    `SELECT input_codec, input IS NULL AS input_null FROM ${args.table} WHERE project_id=? AND id=?`,
    args.projectId,
    args.rowId,
  )) as { input_codec?: unknown; input_null?: unknown } | undefined;
  return (
    Boolean(existing) && Number(existing.input_codec) === 0 && Number(existing.input_null) === 1
  );
}
