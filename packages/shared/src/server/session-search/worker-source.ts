export const SESSION_SEARCH_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
const { createLocalDatabase, initializeLocalDatabase } = require(workerData.connectionPath);
const { processDirty } = require(workerData.indexerPath);
const { enqueueBackfill } = require(workerData.backfillPath);
const db = createLocalDatabase(workerData.dbPath, false, workerData.authToken);
await initializeLocalDatabase(db);
let stopped = false;
let running = Promise.resolve();
let timer;
let healthy = false;
async function tick() {
  if (stopped) return;
  let delay = 1000;
  try {
    const enqueued = await enqueueBackfill(db);
    const processed = await processDirty(db, 100);
    if (enqueued || processed) delay = 250;
    if (!healthy) { healthy = true; parentPort.postMessage({ type: "tick-ok" }); }
  } catch (error) {
    delay = 5000;
    healthy = false;
    parentPort.postMessage({ type: "error", error: error instanceof Error ? error.name : "Indexing failed" });
  } finally {
    if (!stopped) timer = setTimeout(() => { running = tick(); }, delay);
  }
}
parentPort.on("message", async (message) => { if (message === "stop") { stopped = true; clearTimeout(timer); await running; await db.close(); parentPort.postMessage({ type: "stopped" }); process.exit(0); } });
parentPort.postMessage({ type: "ready" }); running = tick();
})().catch(error => { throw error; });
`;
