import { type LocalExecutor, withReadSnapshot } from "../../db/local";
import { decodeIoRow } from "../adapters/io-compression";
import { canReadSnapshot, ioRowsGuardFor } from "../adapters/io-read";
import { hydrateIoRows } from "../io-cas/read";
import { IO_CAS_READ_BUDGET } from "../io-cas/reader-source";
import { extractMessages } from "./extraction";
import { type SearchSource, SessionSearchStorage } from "./storage";

/**
 * 读取索引源正文。
 *
 * W4b：正文读取与 codec 2 的 hydrate 必须在**同一只读快照**内完成（设计 §7.2），
 * 因此扫描前先进入读快照；引擎不具备快照能力时（W1 NO-GO）不 hydrate，
 * 由守卫在发现 codec 2 行时拒绝，绝不把未装配的 manifest 交给搜索解析。
 * `project_id` 必须随行投影：池内容按项目隔离，hydrate 缺它即 `IO_CAS_PROJECT_REQUIRED`。
 */
export async function readSource(
  db: LocalExecutor,
  source: SearchSource,
): Promise<{
  input: unknown;
  output: unknown;
  type?: string;
  traceId?: string;
  eventTime?: string;
} | null> {
  const table = source.kind === "trace" ? "traces" : "observations";
  const columns =
    source.kind === "trace"
      ? "NULL AS type,id AS traceId,timestamp AS eventTime"
      : "type,trace_id AS traceId,start_time AS eventTime";
  const guard = ioRowsGuardFor(db);
  const snapshotCapable = canReadSnapshot(db);
  const read = async (executor: LocalExecutor) => {
    const row = await executor.get(
      `SELECT project_id,input,input_codec,input_raw_size,output,output_codec,output_raw_size,is_deleted,${columns} FROM ${table} WHERE project_id=? AND id=?`,
      source.projectId,
      source.id,
    );
    if (!row || row.is_deleted) return null;
    if (snapshotCapable) await hydrateIoRows(executor, [row], IO_CAS_READ_BUDGET);
    guard([row]);
    return decodeIoRow(row) as {
      input: unknown;
      output: unknown;
      type?: string;
      traceId?: string;
      eventTime?: string;
    };
  };
  // 已持有事务句柄时沿用调用方的事务（`withReadSnapshot` 的既有语义）。
  if (snapshotCapable && "transactionAsync" in db) return withReadSnapshot(db, read);
  return read(db);
}

export async function processDirty(db: LocalExecutor, limit = 100): Promise<number> {
  const storage = new SessionSearchStorage(db);
  let count = 0;
  let budget = 2 * 1024 * 1024;
  for (const source of await storage.listDirty(limit)) {
    try {
      const table = source.kind === "trace" ? "traces" : "observations";
      const size = await db.get(
        `SELECT COALESCE(input_raw_size,length(CAST(input AS BLOB)),0)+COALESCE(output_raw_size,length(CAST(output AS BLOB)),0) AS bytes FROM ${table} WHERE project_id=? AND id=?`,
        source.projectId,
        source.id,
      );
      const bytes = Number(size?.bytes ?? 0);
      if (bytes > 2 * 1024 * 1024) {
        await storage.markLimited(source, "source exceeds 2MiB indexing batch budget");
        continue;
      }
      if (bytes > budget && count > 0) break;
      const row = await readSource(db, source);
      await storage.indexSource(
        { ...source, eventTime: row?.eventTime ?? source.eventTime, traceId: row?.traceId },
        row ? extractMessages(row.input, row.output, row.type) : [],
      );
      budget -= bytes;
      count++;
    } catch (error) {
      await storage.markFailed(source, error);
    }
  }
  return count;
}
