/**
 * Ingestion (write-path) stress test.
 *
 * Hammers POST /api/public/ingestion with concurrent workers, each sending a
 * batch of realistic traces (with cache token usage). Reports throughput in
 * both requests/s and events/s plus latency percentiles — the key metric for
 * an observability backend's write path.
 *
 * Usage:
 *   node scripts/stress/ingest.mjs
 *
 * Env overrides:
 *   BASE         server URL          (default http://localhost:23432)
 *   DURATION     seconds to run      (default 30)
 *   CONCURRENCY  parallel workers    (default 10)
 *   BATCH        traces per request  (default 5)
 *   RATE         max requests/s      (default 0 = unlimited)
 *   CACHE        include cache usage (default true)
 *
 * Examples:
 *   DURATION=60 CONCURRENCY=32 node scripts/stress/ingest.mjs
 *   RATE=200 DURATION=120 node scripts/stress/ingest.mjs   # steady-state
 */

import { ensureCreds, loadConfig, postIngestion } from "./lib/client.mjs";
import { makeBatch } from "./lib/payloads.mjs";
import { runAndCollect } from "./lib/runner.mjs";

const cfg = loadConfig();
const creds = await ensureCreds(cfg);

console.log(`Ingestion stress → ${creds.baseUrl}`);
console.log(
  `project=${creds.projectName}  duration=${cfg.duration}s  ` +
    `concurrency=${cfg.concurrency}  traces/batch=${cfg.tracesPerBatch}  ` +
    `rate=${cfg.targetRps || "unlimited"}`,
);

const stats = await runAndCollect("ingestion", {
  concurrency: cfg.concurrency,
  duration: cfg.duration,
  targetRps: cfg.targetRps,
  progressEvery: cfg.progressEvery,
  task: async () => {
    const { batch, eventCount } = makeBatch({ traces: cfg.tracesPerBatch, cache: cfg.cache });
    return postIngestion(creds, batch, eventCount);
  },
});

console.log(stats.summarize());

// Exit non-zero if the error rate is significant, so this can gate CI.
const errRate = stats.total ? stats.errors / stats.total : 0;
if (errRate > 0.01) {
  console.error(`\nFAIL: error rate ${(errRate * 100).toFixed(2)}% exceeds 1%`);
  process.exit(1);
}
