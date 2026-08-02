/**
 * Stress-test setup — provisions a dedicated project + API key (via the
 * manage API) and seeds a baseline of traces so read tests have data.
 *
 * Usage:
 *   node scripts/stress/setup.mjs
 *
 * Env overrides:
 *   BASE            server URL            (default http://localhost:23432)
 *   STRESS_PROJECT  project name          (default "stress-test")
 *   SEED_TRACES     baseline traces       (default 200, 0 to skip seeding)
 *   SEED_DAYS       spread seed over days (default 14)
 *
 * Credentials are cached in scripts/stress/.stress-creds.json (gitignored).
 */

import { ensureCreds, envInt, loadConfig, postIngestion } from "./lib/client.mjs";
import { traceEvents } from "./lib/payloads.mjs";

const cfg = loadConfig();
const seedTraces = envInt("SEED_TRACES", 200);
const seedDays = envInt("SEED_DAYS", 14);

console.log(`Stress setup → ${cfg.baseUrl}`);

const creds = await ensureCreds(cfg);
console.log(`Project:  ${creds.projectName} (${creds.projectId})`);
console.log(`Public:   ${creds.publicKey}`);
console.log(`Secret:   ${creds.secretKey}`);

if (seedTraces > 0) {
  console.log(`\nSeeding ${seedTraces} traces over the last ${seedDays} days …`);
  const now = Date.now();
  const span = seedDays * 24 * 3600 * 1000;
  const BATCH = 10; // traces per request
  const CONCURRENCY = 4;

  let remaining = seedTraces;
  let sent = 0;
  let errors = 0;

  // Simple bounded-concurrency loop.
  async function worker() {
    while (remaining > 0) {
      const n = Math.min(BATCH, remaining);
      remaining -= n;
      const batch = [];
      for (let i = 0; i < n; i++) {
        // Spread traces across the window so daily dashboards have series data.
        const ts = now - Math.floor(Math.random() * span);
        batch.push(...traceEvents({ cache: true, ts }));
      }
      const r = await postIngestion(creds, batch, batch.length);
      if (r.ok) {
        sent += n;
      } else {
        errors++;
        remaining += n; // retry this chunk once more
        if (errors > 20) throw new Error(`too many seed errors (last status ${r.status})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`Seeded ${sent} traces (${errors} retried chunks).`);
} else {
  console.log("\nSkipping seeding (SEED_TRACES=0).");
}

console.log("\nReady. Now run, e.g.:");
console.log("  node scripts/stress/ingest.mjs");
console.log("  node scripts/stress/reads.mjs");
console.log("  node scripts/stress/mixed.mjs");
console.log("  node scripts/stress/ramp.mjs");
