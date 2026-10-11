/**
 * Offline perf bench for one trace (and its observations).
 *
 * codec 2（CAS manifest）行必须先在**同一读快照**内 hydrate 再解码（设计 §7.1/§7.2），
 * 否则 `decodeIoRow` 会明确报 `IO_CAS_PARSER_REQUIRED`。快照能力门禁沿用 W1：
 * 只有通过验收的引擎（`PERIFUSE_ENGINE=sqlite` + Bun）才会装配，NO-GO 引擎上的
 * 存量 codec 2 会在开库时被拒绝，而不是给出错误读数。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  getReadSnapshotCapability,
  openLocalDatabase,
  withReadSnapshot,
} from "../packages/shared/dist/src/db/local.js";
import { decodeIoRow } from "../packages/shared/dist/src/server/adapters/io-compression.js";
import { hydrateIoRows } from "../packages/shared/dist/src/server/io-cas/read.js";
import { IO_CAS_READ_BUDGET } from "../packages/shared/dist/src/server/io-cas/reader-source.js";

const dbPath = process.env.DB_PATH ?? join(homedir(), ".peri-fuse/telemetry.turso.db");
const projectId = process.env.PROJECT_ID;
const traceId = process.env.TRACE_ID;
if (!projectId || !traceId) throw new Error("Set PROJECT_ID and TRACE_ID explicitly.");
const db = await openLocalDatabase(dbPath, true);
const params = { projectId, traceId };
const snapshotCapable = getReadSnapshotCapability(db).supported;

/** 读正文时在同一快照内 hydrate；不读正文的基准保持单条 SELECT。 */
async function readRows(query, decode) {
  if (!decode || !snapshotCapable) return db.all(query, params);
  return withReadSnapshot(db, async (tx) => {
    const rows = await tx.all(query, params);
    await hydrateIoRows(tx, rows, IO_CAS_READ_BUDGET);
    return rows;
  });
}

async function bench(name, query, decode = false) {
  const start = performance.now();
  const rows = await readRows(query, decode);
  if (decode) for (const row of rows) decodeIoRow(row);
  console.log(`${name}: ${(performance.now() - start).toFixed(1)}ms, ${rows.length} row(s)`);
}
try {
  await bench(
    "trace lookup",
    "SELECT * FROM traces WHERE project_id=@projectId AND id=@traceId AND is_deleted=0",
    true,
  );
  await bench(
    "observations no IO",
    "SELECT id,type,start_time,total_cost FROM observations WHERE project_id=@projectId AND trace_id=@traceId AND is_deleted=0 ORDER BY start_time",
  );
  await bench(
    "observations with IO",
    "SELECT * FROM observations WHERE project_id=@projectId AND trace_id=@traceId AND is_deleted=0 ORDER BY start_time",
    true,
  );
  await bench(
    "scores",
    "SELECT * FROM scores WHERE project_id=@projectId AND trace_id=@traceId AND is_deleted=0",
  );
} finally {
  await db.close();
}
