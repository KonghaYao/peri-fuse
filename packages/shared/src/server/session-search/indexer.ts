import type { LocalExecutor } from "../../db/local";
import { decodeIoRow } from "../adapters/io-compression";
import { extractMessages } from "./extraction";
import { type SearchSource, SessionSearchStorage } from "./storage";

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
  const row = await db.get(
    `SELECT input,input_codec,input_raw_size,output,output_codec,output_raw_size,is_deleted,${columns} FROM ${table} WHERE project_id=? AND id=?`,
    source.projectId,
    source.id,
  );
  if (!row || row.is_deleted) return null;
  return decodeIoRow(row) as {
    input: unknown;
    output: unknown;
    type?: string;
    traceId?: string;
    eventTime?: string;
  };
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
