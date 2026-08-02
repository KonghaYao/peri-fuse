/**
 * Mixed read/write workload stress test.
 *
 * Simulates realistic traffic: each worker iteration performs either an
 * ingestion write or a query read, chosen by a configurable ratio. Reports
 * write and read latency/throughput separately so you can see whether writes
 * starve reads (SQLite lock contention) under combined load.
 *
 * Usage:
 *   node scripts/stress/mixed.mjs
 *
 * Env overrides:
 *   BASE         server URL          (default http://localhost:23432)
 *   DURATION     seconds to run      (default 30)
 *   CONCURRENCY  parallel workers    (default 16)
 *   WRITE_RATIO  fraction of writes  (default 0.3)
 *   BATCH        traces per write    (default 3)
 *   RATE         max requests/s      (default 0 = unlimited)
 */

import { ensureCreds, loadConfig, postIngestion, request } from "./lib/client.mjs";
import { makeBatch } from "./lib/payloads.mjs";
import { runLoad } from "./lib/runner.mjs";
import { Stats } from "./lib/stats.mjs";

const cfg = loadConfig();
const writeRatio = Math.min(1, Math.max(0, Number.parseFloat(process.env.WRITE_RATIO ?? "0.3")));
const creds = await ensureCreds(cfg);

console.log(`Mixed stress → ${creds.baseUrl}`);

// A small read mix (no per-endpoint breakdown here; use reads.mjs for that).
const readPaths = [
  () => "/api/public/dashboard",
  () => "/api/public/traces?limit=50&page=1",
  () => "/api/public/sessions?limit=50&page=1",
  () => "/api/public/observations?limit=50&page=1",
  () => "/api/public/users",
];

const overall = new Stats("mixed-overall").start();
const writes = new Stats("writes").start();
const reads = new Stats("reads").start();

const record = (r) => {
  const target = r.kind === "write" ? writes : reads;
  for (const s of [overall, target]) {
    if (r.ok) s.recordOk(r.ms, { events: r.events ?? 0, bytes: r.bytes ?? 0 });
    else s.recordError(r.ms, r.status);
  }
};

console.log(
  `duration=${cfg.duration}s  concurrency=${cfg.concurrency}  ` +
    `writeRatio=${writeRatio}  rate=${cfg.targetRps || "unlimited"}`,
);

await runLoad({
  concurrency: cfg.concurrency,
  duration: cfg.duration,
  targetRps: cfg.targetRps,
  progressEvery: cfg.progressEvery,
  stats: overall,
  record,
  task: async () => {
    if (Math.random() < writeRatio) {
      const { batch, eventCount } = makeBatch({ traces: cfg.tracesPerBatch, cache: cfg.cache });
      const r = await postIngestion(creds, batch, eventCount);
      return { ...r, kind: "write" };
    }
    const path = readPaths[(Math.random() * readPaths.length) | 0]();
    const r = await request(creds, "GET", path);
    return { ...r, kind: "read" };
  },
});

overall.stop();
writes.stop();
reads.stop();

console.log(overall.summarize());
console.log(writes.summarize());
console.log(reads.summarize());

const errRate = overall.total ? overall.errors / overall.total : 0;
if (errRate > 0.01) {
  console.error(`\nFAIL: error rate ${(errRate * 100).toFixed(2)}% exceeds 1%`);
  process.exit(1);
}
