/**
 * Perf benchmark: replicate GET /api/public/traces/:traceId query chain
 * against ~/.peri-fuse/telemetry.db to locate the bottleneck.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import DatabaseModule from "/Users/konghayao/code/ai/langfuse-lite/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/index.js";
const Database = DatabaseModule.default ?? DatabaseModule;
import { performance } from "node:perf_hooks";

const DB = process.env.DB_PATH ?? `${process.env.HOME}/.peri-fuse/telemetry.db`;
const TRACE_ID = process.env.TRACE_ID ?? "01a00872b5917561906806f4fccf4491";
const PROJECT_ID = process.env.PROJECT_ID ?? "e44b3574-143b-46dd-aa68-5c489b30b1f6";

const db = new Database(DB, { readonly: true });
db.pragma("journal_mode = wal");

function bench(name, fn) {
  const t0 = performance.now();
  const result = fn();
  const dt = performance.now() - t0;
  console.log(`${name}: ${dt.toFixed(1)}ms`);
  return result;
}

// 1. trace lookup (liteGetTraceById)
const traceRows = bench("trace lookup", () =>
  db
    .prepare(
      `SELECT * FROM traces WHERE project_id = @projectId AND id = @traceId AND is_deleted = 0 LIMIT 1`,
    )
    .all({ projectId: PROJECT_ID, traceId: TRACE_ID }),
);
const trace = traceRows[0];
console.log(`  trace input: ${((trace?.input?.length ?? 0) / 1048576).toFixed(2)}MB`);

// 2. observations WITHOUT io (metrics-only path)
bench("obs no-io", () =>
  db
    .prepare(
      `SELECT id, trace_id, project_id, type, parent_observation_id,
         environment, start_time, end_time, name, level, status_message,
         version, model as provided_model_name,
         '' as internal_model_id,
         model_parameters,
         provided_usage_details, usage_details,
         provided_cost_details, cost_details,
         total_cost,
         '' as usage_pricing_tier_id,
         '' as usage_pricing_tier_name,
         completion_start_time,
         prompt_id, prompt_name, prompt_version,
         created_at, updated_at, event_ts
      FROM observations
      WHERE project_id = @projectId AND trace_id = @traceId AND is_deleted = 0
      ORDER BY start_time ASC`,
    )
    .all({ projectId: PROJECT_ID, traceId: TRACE_ID }),
);

// 3. observations WITH io (24MB input)
const obsWithIO = bench("obs WITH io (24MB)", () =>
  db
    .prepare(
      `SELECT id, trace_id, project_id, type, parent_observation_id,
         environment, start_time, end_time, name, level, status_message,
         version, input, output, metadata,
         model as provided_model_name,
         '' as internal_model_id,
         model_parameters,
         provided_usage_details, usage_details,
         provided_cost_details, cost_details,
         total_cost,
         '' as usage_pricing_tier_id,
         '' as usage_pricing_tier_name,
         completion_start_time,
         prompt_id, prompt_name, prompt_version,
         created_at, updated_at, event_ts
      FROM observations
      WHERE project_id = @projectId AND trace_id = @traceId AND is_deleted = 0
      ORDER BY start_time ASC`,
    )
    .all({ projectId: PROJECT_ID, traceId: TRACE_ID }),
);
const ioBytes = obsWithIO.reduce((s, r) => s + (r.input?.length ?? 0) + (r.output?.length ?? 0), 0);
console.log(`  rows=${obsWithIO.length} io=${(ioBytes / 1048576).toFixed(2)}MB`);

// 4. JSON round-trip: what the API must serialize (parse + stringify)
bench("JSON.parse+stringify of obs io", () =>
  JSON.stringify(obsWithIO.map((o) => ({ ...o, input: JSON.parse(o.input), output: JSON.parse(o.output) }))),
);

// 5. score query (liteGetScoresForTraces)
bench("scores query", () =>
  db
    .prepare(
      `SELECT * FROM scores WHERE project_id = @projectId AND trace_id = @traceId AND is_deleted = 0`,
    )
    .all({ projectId: PROJECT_ID, traceId: TRACE_ID }),
);

// 6. EXPLAIN the observations query plan
console.log("\nEXPLAIN QUERY PLAN (obs):");
const plan = db
  .prepare(
    `EXPLAIN QUERY PLAN SELECT id FROM observations WHERE project_id = @projectId AND trace_id = @traceId AND is_deleted = 0`,
  )
  .all({ projectId: PROJECT_ID, traceId: TRACE_ID });
for (const row of plan) console.log(`  ${row.detail}`);

console.log("\nEXPLAIN QUERY PLAN (trace):");
const tplan = db
  .prepare(
    `EXPLAIN QUERY PLAN SELECT id FROM traces WHERE project_id = @projectId AND id = @traceId AND is_deleted = 0 LIMIT 1`,
  )
  .all({ projectId: PROJECT_ID, traceId: TRACE_ID });
for (const row of tplan) console.log(`  ${row.detail}`);

db.close();
