/**
 * Ramp-up capacity test.
 *
 * Runs the ingestion workload in stages of increasing concurrency (1, 2, 4,
 * 8, … up to MAX_CONCURRENCY), each for STAGE_DURATION seconds, and prints a
 * throughput-vs-concurrency table. The saturation point is where req/s stops
 * growing and p99 latency climbs sharply — that's the service's effective
 * write capacity on this hardware.
 *
 * Usage:
 *   node scripts/stress/ramp.mjs
 *
 * Env overrides:
 *   BASE              server URL           (default http://localhost:23432)
 *   MAX_CONCURRENCY   ceiling to ramp to   (default 64)
 *   STAGE_DURATION    seconds per stage    (default 8)
 *   BATCH             traces per request   (default 5)
 */

import { ensureCreds, envInt, loadConfig, postIngestion } from "./lib/client.mjs";
import { makeBatch } from "./lib/payloads.mjs";
import { runAndCollect } from "./lib/runner.mjs";
import { Stats } from "./lib/stats.mjs";

const cfg = loadConfig();
const maxConcurrency = envInt("MAX_CONCURRENCY", 64);
const stageDuration = envInt("STAGE_DURATION", 8);
const creds = await ensureCreds(cfg);

console.log(`Ramp test → ${creds.baseUrl}`);
console.log(
  `maxConcurrency=${maxConcurrency}  stageDuration=${stageDuration}s  traces/batch=${cfg.tracesPerBatch}\n`,
);

const stages = [];
for (let c = 1; c <= maxConcurrency; c *= 2) stages.push(c);

const task = async () => {
  const { batch, eventCount } = makeBatch({ traces: cfg.tracesPerBatch, cache: cfg.cache });
  return postIngestion(creds, batch, eventCount);
};

const results = [];
for (const concurrency of stages) {
  process.stdout.write(`stage concurrency=${String(concurrency).padStart(3)} … `);
  const stats = await runAndCollect(`ramp-${concurrency}`, {
    concurrency,
    duration: stageDuration,
    progressEvery: 0, // quiet per-stage
    task,
  });
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p99 = Stats.percentile(sorted, 99);
  const errRate = stats.total ? (stats.errors / stats.total) * 100 : 0;
  results.push({
    concurrency,
    rps: stats.total / stats.durationSec(),
    eventsPerSec: stats.events / stats.durationSec(),
    p99,
    errRate,
  });
  console.log(
    `${results[results.length - 1].rps.toFixed(0)} req/s  ` +
      `${results[results.length - 1].eventsPerSec.toFixed(0)} ev/s  ` +
      `p99=${p99.toFixed(0)}ms  err=${errRate.toFixed(1)}%`,
  );
}

// Summary table.
console.log("\n=== ramp summary (ingestion) ===");
console.log("concurrency   req/s   events/s   p99(ms)   err%");
for (const r of results) {
  console.log(
    `${String(r.concurrency).padStart(11)} ${r.rps.toFixed(0).padStart(7)} ` +
      `${r.eventsPerSec.toFixed(0).padStart(10)} ${r.p99.toFixed(0).padStart(9)} ` +
      `${r.errRate.toFixed(1).padStart(6)}`,
  );
}

// Crude saturation detection: first stage where p99 more than doubles vs the
// previous stage while throughput gains flatten.
let knee = null;
for (let i = 1; i < results.length; i++) {
  const prev = results[i - 1];
  const cur = results[i];
  const throughputGain = prev.rps > 0 ? cur.rps / prev.rps : 1;
  if (cur.p99 > prev.p99 * 2 && throughputGain < 1.3) {
    knee = prev.concurrency;
    break;
  }
}
if (knee) {
  console.log(
    `\n→ saturation knee near concurrency=${knee} (beyond this, latency degrades faster than throughput grows)`,
  );
} else {
  console.log(
    "\n→ no clear saturation knee reached; the service kept scaling within the tested range.",
  );
}
