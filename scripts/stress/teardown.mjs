/**
 * Stress-test teardown — removes the stress project's API key and all of its
 * telemetry data, then deletes the cached credentials file.
 *
 * The API key is removed via the manage API; telemetry rows are deleted
 * directly from the SQLite file (scoped strictly to the stress project id, so
 * real data is never touched).
 *
 * Usage:
 *   node scripts/stress/teardown.mjs
 *
 * Env overrides:
 *   BASE  server URL (default http://localhost:23432)
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CREDS_FILE, envStr } from "./lib/client.mjs";

const baseUrl = envStr("BASE", "http://localhost:23432");

if (!fs.existsSync(CREDS_FILE)) {
  console.log("No stress credentials found — nothing to do.");
  process.exit(0);
}

const creds = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
console.log(`Tearing down stress project ${creds.projectName} (${creds.projectId}) …`);

// 1. Delete the API key via the manage API (look up its id by publicKey).
try {
  const keysRes = await fetch(`${baseUrl}/api/manage/projects/${creds.projectId}/keys`);
  if (keysRes.ok) {
    const keys = await keysRes.json();
    const match = keys.find((k) => k.publicKey === creds.publicKey);
    if (match) {
      const del = await fetch(`${baseUrl}/api/manage/keys/${match.id}`, { method: "DELETE" });
      console.log(`API key deleted: ${del.ok ? "ok" : `status ${del.status}`}`);
    } else {
      console.log("API key not found (already deleted?).");
    }
  } else {
    console.warn(`Could not list keys (status ${keysRes.status}) — skipping key deletion.`);
  }
} catch (e) {
  console.warn(`Key deletion failed (is the server running?): ${e.message}`);
}

// 2. Delete telemetry rows directly from SQLite, scoped to the project id.
const home = process.env.PERIFUSE_HOME || path.join(os.homedir(), ".peri-fuse");
const dbPath = process.env.LANGFUSE_SQLITE_DB_PATH || path.join(home, "telemetry.db");

// better-sqlite3 lives in the shared package's node_modules.
const sharedPkg = fileURLToPath(new URL("../../packages/shared/package.json", import.meta.url));
const requireShared = createRequire(sharedPkg);
const Database = requireShared("better-sqlite3");

const db = new Database(dbPath);
try {
  const pid = creds.projectId;
  const del = (table) => db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(pid).changes;
  const observations = del("observations");
  const scores = del("scores");
  const metrics = del("trace_metrics");
  const traces = del("traces");
  console.log(
    `Telemetry deleted: traces=${traces} observations=${observations} ` +
      `scores=${scores} trace_metrics=${metrics}`,
  );
} finally {
  db.close();
}

// 3. Remove the cached credentials.
fs.unlinkSync(CREDS_FILE);
console.log("Credentials file removed. Teardown complete.");
