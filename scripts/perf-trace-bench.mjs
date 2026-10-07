import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openLocalDatabase } from "../packages/shared/dist/src/db/local.js";
import { decodeIoRow } from "../packages/shared/dist/src/server/adapters/io-compression.js";

const dbPath = process.env.DB_PATH ?? join(homedir(), ".peri-fuse/telemetry.turso.db");
const projectId = process.env.PROJECT_ID;
const traceId = process.env.TRACE_ID;
if (!projectId || !traceId) throw new Error("Set PROJECT_ID and TRACE_ID explicitly.");
const db = await openLocalDatabase(dbPath, true);
async function bench(name, query, decode = false) {
  const start = performance.now();
  const rows = await db.all(query, { projectId, traceId });
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
