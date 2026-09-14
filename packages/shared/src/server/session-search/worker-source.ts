export const SESSION_SEARCH_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
const { processDirty } = require(workerData.indexerPath);
const { enqueueBackfill } = require(workerData.backfillPath);
const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
let stopped = false;
function tick() { if (!stopped) { try { enqueueBackfill(db); processDirty(db, 100); parentPort.postMessage({ type: "tick-ok" }); } catch (error) { parentPort.postMessage({ type: "error", error: String(error) }); } } }
parentPort.on("message", (message) => { if (message === "stop") { stopped = true; db.close(); parentPort.postMessage({ type: "stopped" }); process.exit(0); } });
parentPort.postMessage({ type: "ready" }); tick(); setInterval(tick, 250);
`;
