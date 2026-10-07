import { homedir } from "node:os";
import { join } from "node:path";
import {
  isRemoteDatabaseUrl,
  localFileExists,
  openLocalDatabase,
  resolveDatabaseConfig,
} from "../packages/shared/dist/src/db/local.js";

process.env.LANGFUSE_MODE = "lite";
const { SQLiteTelemetryAdapter } = await import(
  "../packages/shared/dist/src/server/adapters/sqlite-telemetry-adapter.js"
);

const args = process.argv.slice(2);
const argument = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const projectId = argument("--project");
const beforeRaw = argument("--before");
const dryRun = args.includes("--dry-run");
if (!projectId && !beforeRaw) throw new Error("Pass --project <id> and/or --before <ISO date>.");
if (args.includes("--vacuum"))
  throw new Error(
    "In-place VACUUM is not supported by this Turso configuration. Use an offline database export/rebuild instead.",
  );
const date = beforeRaw ? new Date(beforeRaw) : null;
if (date && !Number.isFinite(date.getTime())) throw new Error("Invalid --before date");
const before = date?.toISOString().replace("T", " ").replace("Z", "");
const config = resolveDatabaseConfig(
  "telemetry",
  join(process.env.PERIFUSE_HOME || join(homedir(), ".peri-fuse"), "telemetry.turso.db"),
);
const dbPath = config.url;
if (!isRemoteDatabaseUrl(dbPath) && !localFileExists(dbPath))
  throw new Error(`Telemetry database does not exist: ${dbPath}`);
let reader;
let adapter;
try {
  if (!dryRun) {
    adapter = new SQLiteTelemetryAdapter(dbPath);
    await adapter.initialize();
  }
  reader = await openLocalDatabase(dbPath, true, config.authToken);
  if (!(await reader.get("SELECT 1 FROM sqlite_master WHERE name='_perifuse_migrations'")))
    throw new Error("Legacy database is not supported; select a fresh Turso database.");
  for (const [table, timeColumn] of Object.entries({
    observations: "start_time",
    scores: "timestamp",
    traces: "timestamp",
    trace_metrics: "timestamp",
    daily_stats: "day",
    daily_model_stats: "day",
  })) {
    const clauses = [];
    const params = {};
    if (projectId) {
      clauses.push("project_id = @projectId");
      params.projectId = projectId;
    }
    if (before) {
      clauses.push(`${timeColumn} < @before`);
      params.before = timeColumn === "day" ? before.slice(0, 10) : before;
    }
    const where = ` WHERE ${clauses.join(" AND ")}`;
    const count = await reader.get(`SELECT COUNT(*) AS count FROM ${table}${where}`, params);
    console.log(
      `${table}: ${count.count}${dryRun ? " row(s) would be deleted" : " row(s) matched"}`,
    );
    if (adapter) {
      for (;;) {
        const result = await adapter.command({
          query: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}${where} LIMIT 500)`,
          params,
        });
        if (result.changes < 500) break;
      }
    }
  }
} finally {
  await adapter?.close();
  await reader?.close();
}
