import {
  buildCasReaderSource,
  buildIoRowsGuardSource,
  buildIoRowWeigherSource,
} from "../io-cas/reader-source";
import { IO_READER_SOURCE } from "./io-compression";

/**
 * Inline worker source keeps development and bundled entry points identical.
 *
 * W4b：worker 与主线程共用同一份 CAS 读实现。`hydrateIoRows` 及其
 * hash / chunk / manifest 依赖由 `buildCasReaderSource()` 在运行时生成注入，
 * 绝不手抄第二套 parser；`node:crypto` / `node:zlib` / 预算都通过生成的依赖表达式与
 * `workerData` 显式传入，函数体不捕获模块闭包。
 *
 * 事务纪律：每个请求在自己的读快照（或只读连接）内 prepare → iterate → 关闭，
 * 语句不跨事务生命周期复用；`sql` 因此不需要也不能有模块级 statement cache。
 */
export const SQLITE_READ_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
const { assertReadSnapshotSupported, createLocalDatabase, getReadSnapshotCapability, withReadSnapshot } = require(workerData.connectionPath);
const db = createLocalDatabase(workerData.dbPath, true, workerData.authToken);
await db.connect();
${IO_READER_SOURCE}
${buildCasReaderSource()}
${buildIoRowsGuardSource("() => assertReadSnapshotSupported(db)")}
${buildIoRowWeigherSource()}
const snapshotCapable = getReadSnapshotCapability(db).supported;
const resultLimitError = () => {
  const error = new Error("SQLite query result limit exceeded; paginate or narrow the query");
  error.code = "RESULT_LIMIT";
  return error;
};
// 原始行是解码结果的保守下界，内存闸门用 2x 上限提前止损；判定口径仍是解码后计费。
const collectRows = async (cursor, sql, params, maxResultRows, maxResultBytes) => {
  const rows = [];
  let bytes = 0;
  for await (const source of cursor.iterate(sql, params, { queryTimeout: 30000 })) {
    bytes += weighIoRow(source);
    if (rows.length >= maxResultRows || bytes > maxResultBytes * 2) throw resultLimitError();
    rows.push(source);
  }
  return rows;
};
const decodeRows = (rows, maxResultRows, maxResultBytes) => {
  const decoded = [];
  let bytes = 0;
  for (const source of rows) {
    const row = decodeIoRow(source);
    bytes += weighIoRow(row);
    if (decoded.length >= maxResultRows || bytes > maxResultBytes) throw resultLimitError();
    decoded.push(row);
  }
  return decoded;
};
parentPort.on("message", async ({ id, sql, params, maxResultRows, maxResultBytes, ioRead }) => {
  try {
    // ioRead=auto 先在读快照内 hydrate，之后才 decode；NO-GO 引擎由守卫拒绝 codec 2。
    const hydrate = ioRead !== "none" && snapshotCapable;
    const rows = hydrate
      ? await withReadSnapshot(db, async (tx) => {
          const collected = await collectRows(tx, sql, params, maxResultRows, maxResultBytes);
          await hydrateIoRows(tx, collected, {
            maxBytes: workerData.hydrateBudgetBytes,
            windowBytes: workerData.hydrateWindowBytes,
          });
          return collected;
        })
      : await collectRows(db, sql, params, maxResultRows, maxResultBytes);
    guardIoRows(rows);
    parentPort.postMessage({ id, ok: true, rows: decodeRows(rows, maxResultRows, maxResultBytes) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, code: error.code, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort.postMessage({ type: "ready" });
})().catch(error => { throw error; });
`;
