import type { Database, Transaction } from "@tursodatabase/database";
import { createDatabaseError } from "./errors";
import { SnapshotLifetime } from "./read-snapshot-executor";

export interface ReadSnapshotMetrics {
  engine: "sqlite" | "turso" | "remote";
  waitMs: number;
  snapshotMs: number;
  outcome: "success" | "error" | "cancelled";
}

export interface ReadSnapshotOptions {
  signal?: AbortSignal;
  /** 包含排队时间；同步 native SQL 只能在返回事件循环后响应取消。 */
  timeoutMs?: number;
  onMetrics?: (metrics: ReadSnapshotMetrics) => void;
}

export interface ReadSnapshotProvider {
  engine: ReadSnapshotMetrics["engine"];
  supported: boolean;
  run<T>(callback: (tx: Transaction) => Promise<T>, signal: AbortSignal): Promise<T>;
}

const providers = new WeakMap<object, ReadSnapshotProvider>();

/** 只供引擎接线；未登记的连接不能宣称已证明快照能力。 */
export function registerReadSnapshot(db: object, provider: ReadSnapshotProvider): void {
  providers.set(db, provider);
}

export function getReadSnapshotCapability(db: object) {
  const provider = providers.get(db);
  return { engine: provider?.engine, supported: provider?.supported === true };
}

/** 启用 CAS/GC 或发现已有 codec 2 时，启动方必须调用此门禁。 */
export function assertReadSnapshotSupported(db: object): void {
  if (!getReadSnapshotCapability(db).supported)
    throw createDatabaseError(
      "PERIFUSE_READ_SNAPSHOT_UNSUPPORTED",
      "CAS/GC requires a verified read snapshot engine",
    );
}

/** 启动时拒绝无法安全读取的存量 codec 2；CAS/GC 开关由其 owner 调用门禁。 */
export async function assertStoredReadSnapshotCompatible(db: Database): Promise<void> {
  if (getReadSnapshotCapability(db).supported) return;
  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'",
  );
  if (!table) return;
  const columns = (await db.all("PRAGMA table_info(observations)")) as { name: string }[];
  if (!columns.some((column) => column.name === "input_codec")) return;
  if (await db.get("SELECT 1 AS present FROM observations WHERE input_codec=2 LIMIT 1"))
    assertReadSnapshotSupported(db);
}

/** 根查询及所有内容池查询必须使用 callback 收到的同一个 tx。 */
export async function withReadSnapshot<T>(
  db: Database | Transaction,
  callback: (tx: Transaction) => Promise<T>,
  options: ReadSnapshotOptions = {},
): Promise<T> {
  // 已有写事务的提交/回滚由外层负责，不能再次 BEGIN 或释放其锁。
  if (!("transactionAsync" in db)) return callback(db);
  assertReadSnapshotSupported(db);
  return runReadSnapshot(providers.get(db)!, callback, options);
}

/** 引擎验收入口；remote 未通过真实部署验证，不能经公共入口使用。 */
export async function runReadSnapshot<T>(
  provider: ReadSnapshotProvider,
  callback: (tx: Transaction) => Promise<T>,
  options: ReadSnapshotOptions = {},
): Promise<T> {
  const lifetime = new SnapshotLifetime(options);
  const started = performance.now();
  let acquired: number | undefined;
  let outcome: ReadSnapshotMetrics["outcome"] = "error";
  try {
    lifetime.check();
    const result = await provider.run(async (tx) => {
      acquired = performance.now();
      return lifetime.run(tx, callback);
    }, lifetime.signal);
    if (lifetime.signal.aborted)
      throw createDatabaseError("PERIFUSE_READ_SNAPSHOT_CANCELLED", "Read snapshot cancelled");
    outcome = "success";
    return result;
  } finally {
    if (lifetime.signal.aborted) outcome = "cancelled";
    lifetime.dispose();
    const ended = performance.now();
    // 观测回调不能影响事务结果，更不能阻止锁释放。
    try {
      options.onMetrics?.({
        engine: provider.engine,
        waitMs: (acquired ?? ended) - started,
        snapshotMs: acquired === undefined ? 0 : ended - acquired,
        outcome,
      });
    } catch {
      // 指标消费者自行处理故障；不得记录查询参数或正文。
    }
  }
}
