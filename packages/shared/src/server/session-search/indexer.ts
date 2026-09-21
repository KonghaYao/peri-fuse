import type Database from "better-sqlite3";
import { installIoReader } from "../adapters/io-compression";
import { extractMessages } from "./extraction";
import { type SearchSource, SessionSearchStorage } from "./storage";

export function readSource(
  db: Database.Database,
  source: SearchSource,
): { input: unknown; output: unknown; type?: string; traceId?: string; eventTime?: string } | null {
  installIoReader(db);
  const table = source.kind === "trace" ? "traces" : "observations";
  const columns =
    source.kind === "trace"
      ? "input,output,NULL as type,is_deleted,id as traceId,timestamp as eventTime"
      : "input,output,type,is_deleted,trace_id as traceId,start_time as eventTime";
  const row = db
    .prepare(`SELECT ${columns} FROM perifuse_read_${table} WHERE project_id=? AND id=?`)
    .get(source.projectId, source.id) as
    | {
        input: unknown;
        output: unknown;
        type?: string;
        traceId?: string;
        eventTime?: string;
        is_deleted?: number;
      }
    | undefined;
  if (!row || row.is_deleted) return null;
  return row;
}
export function processDirty(db: Database.Database, limit = 100): number {
  const storage = new SessionSearchStorage(db);
  let count = 0;
  let budget = 2 * 1024 * 1024;
  for (const source of storage.listDirty(limit)) {
    try {
      installIoReader(db);
      const table = source.kind === "trace" ? "traces" : "observations";
      const size = db
        .prepare(
          `SELECT perifuse_io_bytes(input,input_codec,input_raw_size)+perifuse_io_bytes(output,output_codec,output_raw_size) AS bytes FROM ${table} WHERE project_id=? AND id=?`,
        )
        .get(source.projectId, source.id) as { bytes: number } | undefined;
      const bytes = size?.bytes ?? 0;
      if (bytes > 2 * 1024 * 1024) {
        storage.markLimited(source, "source exceeds 2MiB indexing batch budget");
        continue;
      }
      if (bytes > budget && count > 0) break;
      const row = readSource(db, source);
      storage.indexSource(
        { ...source, eventTime: row?.eventTime ?? source.eventTime, traceId: row?.traceId },
        row ? extractMessages(row.input, row.output, row.type) : [],
      );
      budget -= bytes;
      count++;
    } catch (error) {
      storage.markFailed(source, error);
    }
  }
  return count;
}
