import { IO_READER_SOURCE } from "./io-compression";

/** Inline worker source keeps development and bundled entry points identical. */
export const SQLITE_READ_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
const { createLocalDatabase } = require(workerData.connectionPath);
const db = createLocalDatabase(workerData.dbPath, true, workerData.authToken);
await db.connect();
${IO_READER_SOURCE}
const stmtCache = new Map();
let statementBytes = 0;
parentPort.on("message", async ({ id, sql, params, maxResultRows, maxResultBytes }) => {
  try {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = await db.prepare(sql);
      const sqlBytes = sql.length * 2;
      if (sqlBytes <= 64 * 1024) {
        if (stmtCache.size >= 256 || statementBytes + sqlBytes > 1024 * 1024) {
          for (const cached of stmtCache.values()) cached.close();
          stmtCache.clear();
          statementBytes = 0;
        }
        stmtCache.set(sql, stmt);
        statementBytes += sqlBytes;
      }
    }
    const rows = [];
    let bytes = 0;
    for await (const source of stmt.iterate(params, { queryTimeout: 30000 })) {
      const row = decodeIoRow(source);
      bytes += 64;
      for (const [key, value] of Object.entries(row)) {
        bytes += key.length * 2 + 32;
        bytes += typeof value === "string" ? value.length * 2
          : value instanceof Uint8Array ? value.byteLength : 8;
      }
      if (rows.length >= maxResultRows || bytes > maxResultBytes) {
        const error = new Error("SQLite query result limit exceeded; paginate or narrow the query");
        error.code = "RESULT_LIMIT";
        throw error;
      }
      rows.push(row);
    }
    parentPort.postMessage({ id, ok: true, rows });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, code: error.code, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort.postMessage({ type: "ready" });
})().catch(error => { throw error; });
`;
