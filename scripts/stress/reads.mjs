/**
 * Read-path stress test.
 *
 * Hammers the query endpoints (dashboard, traces list/detail/metrics,
 * sessions, observations, users) with a weighted random mix, and reports
 * latency/throughput BOTH in aggregate and per endpoint — so a slow
 * aggregation query stands out clearly.
 *
 * Usage:
 *   node scripts/stress/reads.mjs
 *
 * Env overrides:
 *   BASE         server URL        (default http://localhost:23432)
 *   DURATION     seconds to run    (default 30)
 *   CONCURRENCY  parallel workers  (default 10)
 *   RATE         max requests/s    (default 0 = unlimited)
 *
 * Note: run setup.mjs first so there is data to read.
 */

import { ensureCreds, loadConfig, request } from "./lib/client.mjs";
import { runLoad } from "./lib/runner.mjs";
import { Stats } from "./lib/stats.mjs";

const cfg = loadConfig();
const creds = await ensureCreds(cfg);

console.log(`Read stress → ${creds.baseUrl}`);

// Pull a pool of trace ids so detail/metrics endpoints hit real rows.
let traceIds = [];
try {
  const r = await request(creds, "GET", "/api/public/traces?limit=100&page=1");
  if (r.ok) {
    const body = JSON.parse(r.text);
    traceIds = (body.data ?? []).map((t) => t.id).filter(Boolean);
  }
} catch {
  // ignore — single-trace endpoints will be skipped
}
if (traceIds.length === 0) {
  console.warn("warning: no traces found — run setup.mjs to seed data first.");
}
console.log(`trace id pool: ${traceIds.length}`);

const pickTrace = () => traceIds[(Math.random() * traceIds.length) | 0];
const randPage = () => 1 + ((Math.random() * 5) | 0);

// Weighted endpoint mix. Dashboard is the heaviest aggregation, so give it a
// meaningful share; list endpoints dominate like real UI traffic.
const endpoints = [
  { key: "dashboard", weight: 15, path: () => "/api/public/dashboard" },
  { key: "traces-list", weight: 25, path: () => `/api/public/traces?limit=50&page=${randPage()}` },
  {
    key: "trace-detail",
    weight: 15,
    path: () => (traceIds.length ? `/api/public/traces/${pickTrace()}` : null),
  },
  {
    key: "trace-metrics",
    weight: 10,
    path: () => (traceIds.length ? `/api/public/traces/metrics?traceIds=${pickTrace()}` : null),
  },
  { key: "sessions", weight: 12, path: () => `/api/public/sessions?limit=50&page=${randPage()}` },
  {
    key: "observations",
    weight: 13,
    path: () => `/api/public/observations?limit=50&page=${randPage()}`,
  },
  { key: "users", weight: 10, path: () => "/api/public/users" },
];

const totalWeight = endpoints.reduce((a, e) => a + e.weight, 0);
function pickEndpoint() {
  let r = Math.random() * totalWeight;
  for (const e of endpoints) {
    r -= e.weight;
    if (r <= 0) return e;
  }
  return endpoints[0];
}

// One aggregate collector plus one per endpoint.
const overall = new Stats("reads-overall").start();
const perEndpoint = new Map(endpoints.map((e) => [e.key, new Stats(e.key)]));
for (const s of perEndpoint.values()) s.start();

const record = (r) => {
  const target = r.key ? perEndpoint.get(r.key) : null;
  for (const s of [overall, target].filter(Boolean)) {
    if (r.ok) s.recordOk(r.ms, { bytes: r.bytes });
    else s.recordError(r.ms, r.status);
  }
};

console.log(
  `duration=${cfg.duration}s  concurrency=${cfg.concurrency}  rate=${cfg.targetRps || "unlimited"}`,
);

await runLoad({
  concurrency: cfg.concurrency,
  duration: cfg.duration,
  targetRps: cfg.targetRps,
  progressEvery: cfg.progressEvery,
  stats: overall,
  record,
  task: async () => {
    const ep = pickEndpoint();
    const path = ep.path();
    if (!path) return { ok: true, status: 200, ms: 0, key: null, bytes: 0 }; // skip
    const r = await request(creds, "GET", path);
    return { ...r, key: ep.key };
  },
});

overall.stop();
for (const s of perEndpoint.values()) s.stop();

console.log(overall.summarize());
console.log("\n--- per endpoint ---");
const rows = [...perEndpoint.values()].filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
for (const s of rows) console.log(s.summarize());

const errRate = overall.total ? overall.errors / overall.total : 0;
if (errRate > 0.01) {
  console.error(`\nFAIL: error rate ${(errRate * 100).toFixed(2)}% exceeds 1%`);
  process.exit(1);
}
