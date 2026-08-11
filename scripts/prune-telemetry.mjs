/**
 * Prune telemetry rows from the SQLite store.
 *
 * Deletes observations/scores/traces/trace_metrics (and the daily rollups)
 * scoped by project and/or cutoff date. Chunked deletes keep write-lock
 * bursts short. Optionally VACUUMs afterwards to reclaim disk space.
 *
 * Usage:
 *   node scripts/prune-telemetry.mjs --project <projectId> [--before <ISO date>] [--vacuum] [--dry-run]
 *   node scripts/prune-telemetry.mjs --before 2026-08-01 --vacuum
 *
 * Env overrides (same as the server):
 *   PERIFUSE_HOME, LANGFUSE_SQLITE_DB_PATH
 */

import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);

const projectId = getArg("--project");
const beforeRaw = getArg("--before");
const vacuum = hasFlag("--vacuum");
const dryRun = hasFlag("--dry-run");

if (!projectId && !beforeRaw) {
  console.error("Nothing to do: pass --project <id> and/or --before <ISO date>.");
  process.exit(1);
}

// Normalize --before to the SQLite TEXT timestamp format (exclusive cutoff).
let before = null;
if (beforeRaw) {
  const d = new Date(beforeRaw);
  if (Number.isNaN(d.getTime())) {
    console.error(`Invalid --before date: ${beforeRaw}`);
    process.exit(1);
  }
  before = d.toISOString().replace("T", " ").replace("Z", "");
}

const home = process.env.PERIFUSE_HOME || path.join(os.homedir(), ".peri-fuse");
const dbPath = process.env.LANGFUSE_SQLITE_DB_PATH || path.join(home, "telemetry.db");

// better-sqlite3 lives in the shared package's node_modules.
const sharedPkg = fileURLToPath(new URL("../packages/shared/package.json", import.meta.url));
const Database = createRequire(sharedPkg)("better-sqlite3");

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const CHUNK = 50_000;

// Time column per table; daily rollups compare on the day prefix.
const TIME_COL = {
  observations: "start_time",
  scores: "timestamp",
  traces: "timestamp",
  trace_metrics: "timestamp",
  daily_stats: "day",
  daily_model_stats: "day",
};

function whereFor(table) {
  const clauses = [];
  const params = [];
  if (projectId) {
    clauses.push("project_id = ?");
    params.push(projectId);
  }
  if (before) {
    if (TIME_COL[table] === "day") {
      clauses.push("day < ?");
      params.push(before.slice(0, 10));
    } else if (table === "trace_metrics") {
      // Pre-v4 rows may lack timestamp — treat them as old.
      clauses.push("(timestamp IS NULL OR timestamp < ?)");
      params.push(before);
    } else {
      clauses.push(`${TIME_COL[table]} < ?`);
      params.push(before);
    }
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

try {
  const tables = [
    "observations",
    "scores",
    "traces",
    "trace_metrics",
    "daily_stats",
    "daily_model_stats",
  ];
  console.log(
    `Pruning ${dbPath}\n  project=${projectId ?? "(all)"} before=${before ?? "(all time)"} ${dryRun ? "[dry-run]" : ""}`,
  );
  for (const table of tables) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) continue;
    const { sql, params } = whereFor(table);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}${sql}`).get(...params).c;
    if (dryRun) {
      console.log(`  ${table}: ${count} row(s) would be deleted`);
      continue;
    }
    let deleted = 0;
    const del = db.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}${sql} LIMIT ${CHUNK})`,
    );
    for (;;) {
      const info = del.run(...params);
      deleted += info.changes;
      if (info.changes < CHUNK) break;
    }
    console.log(`  ${table}: matched ${count}, deleted ${deleted}`);
  }
  if (vacuum && !dryRun) {
    console.log("VACUUM (reclaiming disk space, may take a while)…");
    const t0 = Date.now();
    db.exec("VACUUM");
    console.log(`VACUUM done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} finally {
  db.close();
}
console.log("Prune complete.");
