/** Inline worker source keeps development and bundled entry points identical. */
export const SQLITE_READ_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");
db.pragma("cache_size = -8000");
const stmtCache = new Map();
let statementBytes = 0;
parentPort.on("message", ({ id, sql, params, maxResultRows, maxResultBytes }) => {
  try {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      const sqlBytes = sql.length * 2;
      if (sqlBytes <= 64 * 1024) {
        if (stmtCache.size >= 256 || statementBytes + sqlBytes > 1024 * 1024) {
          stmtCache.clear();
          statementBytes = 0;
        }
        stmtCache.set(sql, stmt);
        statementBytes += sqlBytes;
      }
    }
    const rows = [];
    let bytes = 0;
    for (const row of stmt.iterate(params)) {
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
`;
