import {
  assertReadSnapshotSupported,
  getReadSnapshotCapability,
  type LocalDatabase,
  withReadSnapshot,
} from "../../db/local";
import { hydrateIoRows, IO_CAS_CODEC } from "../io-cas/read";
import { IO_CAS_READ_BUDGET, makeIoRowsGuard, weighIoRow } from "../io-cas/reader-source";
import { decodeIoRow } from "./io-compression";
import { isReadOnlySql } from "./sqlite-read-pool";
import { TelemetryQueryError } from "./telemetry-query-context";
import type { TelemetryQueryOpts } from "./types";

/**
 * 读路径 IO 安全层（设计 §7.1 / §7.2，W4b）。
 *
 * 三条规则，适配器、worker 与 search indexer 共同遵守：
 *
 * 1. `ioRead !== "none"` 的读请求在**第一条 SELECT 之前**进入读快照，并在同一快照内
 *    hydrate codec 2 行，之后才允许 `decodeIoRow`（设计 §7.2 步骤 1–3）。
 * 2. 没有读快照能力的引擎（W1 NO-GO：Turso local / remote）不 hydrate，
 *    由守卫在发现 codec 2 行时按门禁拒绝：宁可直接失败，也不返回未解码的 BLOB。
 * 3. 投影层最后一道防线（D-3）：BLOB 正文到达映射层即 `IO_CAS_INVALID`，
 *    `String(Uint8Array)` 的 `"1,2,3,…"` 形态静默损坏被彻底关闭。
 *
 * 计费口径（`weighIoRow`）与 hydrate 预算（`IO_CAS_READ_BUDGET`）都是显式传入的，
 * worker 侧由 `reader-source.ts` 生成的同一份实现承担。
 */

export interface TelemetryReadLimits {
  maxRows: number;
  maxBytes: number;
  /** `Date.now()` 时间戳；原生同步 SQL 只能在返回事件循环后响应超时。 */
  deadline: number;
}

type IoRows = Record<string, unknown>[];

const guards = new WeakMap<object, (rows: readonly Record<string, unknown>[]) => void>();

/**
 * 取该连接的读路径守卫。`assertReadSnapshotSupported` 按连接一次性绑定，
 * 守卫本体与 worker 侧由同一工厂生成。
 */
export function ioRowsGuardFor(db: object) {
  let guard = guards.get(db);
  if (!guard) {
    guard = makeIoRowsGuard({
      casCodec: IO_CAS_CODEC,
      assertSnapshotSupported: () => assertReadSnapshotSupported(db),
    });
    guards.set(db, guard);
  }
  return guard;
}

/** `auto`（默认）读取正文并在需要时 hydrate；`none` 只用于已核实不选 IO 的查询。 */
export function ioReadEnabled(opts: TelemetryQueryOpts): boolean {
  return (opts.ioRead ?? "auto") !== "none";
}

/**
 * 该句柄上的正文读取能否与 hydrate 同快照（与 `withReadSnapshot` 同一判定）：
 * 已持有事务句柄时由调用方负责快照，否则要求引擎通过 W1 的能力门禁。
 */
export function canReadSnapshot(handle: object): boolean {
  return !("transactionAsync" in handle) || getReadSnapshotCapability(handle).supported;
}

/** 投影层取值（D-3）：BLOB 正文说明 hydrate 未执行或投影漏了 codec 列。 */
export function readIoText(row: Record<string, unknown>, field: "input" | "output") {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) throw new Error("IO_CAS_INVALID");
  return typeof value === "string" ? value : String(value);
}

interface RowCursor {
  iterate(
    sql: string,
    parameters?: unknown,
    options?: unknown,
  ): AsyncIterable<Record<string, unknown>>;
}

/**
 * 流式收集原始行并施加内存闸门。
 *
 * 原始行的重量是解码结果的**保守下界**（BLOB 一定小于等于其解码正文，
 * 字符串两侧口径完全相同），因此这里用 `2 × maxBytes` 只作提前止损：
 * 凡是被它拦下的结果，解码计费也必然超限；反之绝不会误伤。
 */
async function collectRows(
  cursor: RowCursor,
  opts: TelemetryQueryOpts,
  limits: TelemetryReadLimits,
): Promise<IoRows> {
  const rows: IoRows = [];
  let bytes = 0;
  for await (const source of cursor.iterate(opts.query, opts.params ?? {}, {
    queryTimeout: opts.timeoutMs ?? 30_000,
  })) {
    opts.signal?.throwIfAborted();
    if (Date.now() >= limits.deadline)
      throw new TelemetryQueryError("TIMEOUT", "Telemetry query timed out");
    bytes += weighIoRow(source);
    if (rows.length >= limits.maxRows || bytes > limits.maxBytes * 2) throw resultLimitError();
    rows.push(source);
  }
  return rows;
}

/** 解码计费（冻结口径）：无论走哪条路径，返回给调用方的行都按解码后的重量判定。 */
function decodeRows(rows: IoRows, limits: TelemetryReadLimits): IoRows {
  const decoded: IoRows = [];
  let bytes = 0;
  for (const source of rows) {
    const row = decodeIoRow(source);
    bytes += weighIoRow(row);
    if (decoded.length >= limits.maxRows || bytes > limits.maxBytes) throw resultLimitError();
    decoded.push(row);
  }
  return decoded;
}

function resultLimitError(): TelemetryQueryError {
  return new TelemetryQueryError(
    "RESULT_LIMIT",
    "Telemetry query result limit exceeded; paginate or narrow the query",
  );
}

/**
 * 适配器 in-process 读主路径。
 *
 * 只有**只读 SQL**（与读池同一判定）才进入快照：快照执行器本身只接受单条
 * SELECT/WITH，把写语句塞进快照会在 `assertSnapshotSql` 处失败而不是静默降级。
 */
export async function readTelemetryRows(
  db: LocalDatabase,
  opts: TelemetryQueryOpts,
  limits: TelemetryReadLimits,
): Promise<IoRows> {
  const guard = ioRowsGuardFor(db);
  const snapshotCapable = getReadSnapshotCapability(db).supported;
  if (ioReadEnabled(opts) && snapshotCapable && isReadOnlySql(opts.query)) {
    return withReadSnapshot(
      db,
      async (tx) => {
        const rows = await collectRows(tx, opts, limits);
        await hydrateIoRows(tx, rows, IO_CAS_READ_BUDGET);
        guard(rows);
        return decodeRows(rows, limits);
      },
      { signal: opts.signal, timeoutMs: opts.timeoutMs },
    );
  }
  const rows = await collectRows(db, opts, limits);
  guard(rows);
  return decodeRows(rows, limits);
}
