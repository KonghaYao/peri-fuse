export const SESSION_SEARCH_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
const { createLocalDatabase, initializeLocalDatabase } = require(workerData.connectionPath);
const { processDirty } = require(workerData.indexerPath);
const { enqueueBackfill } = require(workerData.backfillPath);
const db = createLocalDatabase(workerData.dbPath, false, workerData.authToken);
await initializeLocalDatabase(db);
let stopped = false;
let busy = false;
let running = Promise.resolve();
async function tick() { if (!stopped && !busy) { busy = true; try { await enqueueBackfill(db); await processDirty(db, 100); parentPort.postMessage({ type: "tick-ok" }); } catch (error) { parentPort.postMessage({ type: "error", error: error instanceof Error ? error.name : "Indexing failed" }); } finally { busy = false; } } }
const timer = setInterval(() => { if (!stopped && !busy) running = tick(); }, 250);
parentPort.on("message", async (message) => { if (message === "stop") { stopped = true; clearInterval(timer); await running; await db.close(); parentPort.postMessage({ type: "stopped" }); process.exit(0); } });
parentPort.postMessage({ type: "ready" }); running = tick();
})().catch(error => { throw error; });
`;
