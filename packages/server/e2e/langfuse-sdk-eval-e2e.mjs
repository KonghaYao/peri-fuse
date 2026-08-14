/**
 * Langfuse SDK + REST E2E test for the eval feature set (Phase 1+2):
 * scores (SDK ingestion, 4 data types), score configs CRUD, eval configs CRUD,
 * eval templates CRUD, datasets/items/runs CRUD, POST /api/public/dataset-run-items
 * (run located-or-created by name, traceId inference from observationId).
 *
 * The official Langfuse SDK (3.x) core client has no evals/datasets client
 * methods, so this test drives the score chain via the SDK and the CRUD
 * endpoints via REST (same pattern as langfuse-sdk-e2e.mjs).
 *
 * Usage: BASE=<url> PK=<pk> SK=<sk> node e2e/langfuse-sdk-eval-e2e.mjs
 */
import { Langfuse } from "langfuse";

const BASE = process.env.BASE ?? "http://localhost:23332";
const PK = process.env.PK;
const SK = process.env.SK;
if (!PK || !SK) {
  console.error("ERROR: PK and SK env vars are required (bootstrap credentials).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? " — " + JSON.stringify(extra)?.slice(0, 200) : ""}`);
  }
}
function section(title) {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}

async function api(method, path, body, useAuth = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(useAuth ? { Authorization: "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64") } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runId = crypto.randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------
// 1. Auth negatives
// ---------------------------------------------------------------------------
async function testAuthNegatives() {
  section("Auth negatives (eval endpoints)");
  const noAuth = await api("GET", "/api/public/evals", null, false);
  check("GET /api/public/evals without auth → 401", noAuth.status === 401, noAuth);
  const noAuth2 = await api("GET", "/api/public/datasets", null, false);
  check("GET /api/public/datasets without auth → 401", noAuth2.status === 401, noAuth2);
}

// ---------------------------------------------------------------------------
// 2. SDK ingestion: 4 score data types
// ---------------------------------------------------------------------------
async function testSdkScores() {
  section("SDK ingestion — 4 score data types");

  const langfuse = new Langfuse({
    publicKey: PK,
    secretKey: SK,
    baseUrl: BASE,
    flushAt: 1,
    flushInterval: 0,
  });

  const trace = langfuse.trace({
    id: `eval-t1-${runId}`,
    name: "eval-sdk-trace",
    input: { prompt: "translate to French" },
    output: { text: "bonjour" },
    metadata: { source: "eval-e2e" },
  });

  const names = {
    numeric: `eval-numeric-${runId}`,
    categorical: `eval-categorical-${runId}`,
    boolean: `eval-boolean-${runId}`,
    text: `eval-text-${runId}`,
  };

  // A span under the trace, used later to test observationId → traceId
  // inference on POST /api/public/dataset-run-items (older SDK path).
  const span = trace.span({ id: `eval-span-${runId}`, name: "eval-span", input: "x" });

  // All four data types through the official SDK score() chain, flushed
  // together in one batch.
  trace.score({ name: names.numeric, value: 0.85, dataType: "NUMERIC", comment: "accuracy" });
  trace.score({ name: names.categorical, value: "good", dataType: "CATEGORICAL", comment: "quality" });
  trace.score({ name: names.boolean, value: 1, dataType: "BOOLEAN", comment: "is_correct" });
  trace.score({ name: names.text, value: "very good translation", dataType: "TEXT", comment: "feedback" });
  await langfuse.flushAsync();
  await sleep(500);

  const list = await api("GET", `/api/public/scores?traceId=${trace.id}&limit=10`);
  check("GET /api/public/scores?traceId= → 200", list.status === 200, list);
  const scoreRows = list.body?.data ?? [];
  const byName = Object.fromEntries(scoreRows.map((s) => [s.name, s]));
  check("NUMERIC score persisted", byName[names.numeric]?.value === 0.85, byName[names.numeric]);
  // CATEGORICAL/BOOLEAN/TEXT persist the label in stringValue with a numeric
  // placeholder in value (upstream inflateScoreBody semantics).
  check("CATEGORICAL score persisted", byName[names.categorical]?.stringValue === "good" && byName[names.categorical]?.dataType === "CATEGORICAL", byName[names.categorical]);
  check("BOOLEAN score persisted", byName[names.boolean]?.stringValue === "True" && byName[names.boolean]?.dataType === "BOOLEAN", byName[names.boolean]);
  check("TEXT score persisted", byName[names.text]?.stringValue === "very good translation" && byName[names.text]?.dataType === "TEXT", byName[names.text]);
  check("scores carry traceId", byName[names.numeric]?.traceId === trace.id, byName[names.numeric]);

  // Name filter
  const byNameFilter = await api("GET", `/api/public/scores?name=${encodeURIComponent(names.numeric)}`);
  const numRows = byNameFilter.body?.data ?? [];
  check("GET /api/public/scores?name= filters", byNameFilter.status === 200 && numRows.length >= 1 && numRows.every((s) => s.name === names.numeric), byNameFilter.body);

  return { traceId: trace.id, names, observationId: span.id };
}

// ---------------------------------------------------------------------------
// 3. Score configs CRUD + POST /api/public/scores with configId
// ---------------------------------------------------------------------------
async function testScoreConfigsAndPostScores(ctx) {
  section("Score configs CRUD + POST /api/public/scores");

  const cfgName = `eval-cfg-${runId}`;
  const created = await api("POST", "/api/public/score-configs", {
    name: cfgName,
    dataType: "NUMERIC",
    minValue: 0,
    maxValue: 1,
  });
  check("POST /api/public/score-configs → 200 + id", created.status === 200 && typeof created.body?.id === "string", created);
  const configId = created.body.id;

  const list = await api("GET", "/api/public/score-configs");
  check("GET /api/public/score-configs lists it", list.status === 200 && list.body?.data?.some((c) => c.id === configId), list.body);

  const got = await api("GET", `/api/public/score-configs/${configId}`);
  check("GET /api/public/score-configs/{id} → 200", got.status === 200 && got.body?.name === cfgName, got);

  const missing = await api("GET", `/api/public/score-configs/does-not-exist-${runId}`);
  check("GET unknown score-config → 404", missing.status === 404, missing);

  // POST score referencing the config (zod requires a name; the config name
  // overrides it server-side, so any non-empty name is accepted)
  const posted = await api("POST", "/api/public/scores", {
    traceId: ctx.traceId,
    name: cfgName,
    configId,
    value: 0.9,
    dataType: "NUMERIC",
  });
  check("POST /api/public/scores with configId → 200 {id}", posted.status === 200 && typeof posted.body?.id === "string", posted);
  const postedScoreId = posted.body.id;

  const viaConfig = await api("GET", `/api/public/scores?configId=${configId}`);
  check("GET /api/public/scores?configId= finds it", viaConfig.status === 200 && (viaConfig.body?.data ?? []).some((s) => s.id === postedScoreId), viaConfig.body);

  // Negative: unknown configId → 404
  const badConfig = await api("POST", "/api/public/scores", {
    traceId: ctx.traceId,
    name: "nope",
    configId: "cfg-not-exist",
    value: 0.5,
    dataType: "NUMERIC",
  });
  check("POST scores with unknown configId → 404", badConfig.status === 404, badConfig);

  // Negative: value out of config range → 400
  const outOfRange = await api("POST", "/api/public/scores", {
    traceId: ctx.traceId,
    configId,
    value: 7.5,
    dataType: "NUMERIC",
  });
  check("POST scores out of config range → 400", outOfRange.status === 400, outOfRange);

  // PATCH score config (archive)
  const patched = await api("PATCH", `/api/public/score-configs/${configId}`, { isArchived: true });
  check("PATCH score-config archive → 200", patched.status === 200, patched);

  return { configId };
}

// ---------------------------------------------------------------------------
// 4. Eval configs CRUD (backed by job_configurations)
// ---------------------------------------------------------------------------
async function testEvalConfigs() {
  section("Eval configs CRUD");

  const scoreName = `eval-ec-${runId}`;
  const createBody = (n) => ({
    name: n,
    scoreName,
    targetObject: "trace",
    filter: [{ field: "name", operator: "=", value: "chat" }],
    variableMapping: { input: "trace.input", output: "trace.output" },
    sampling: 1.0,
    delay: 0,
  });

  const c1 = await api("POST", "/api/public/evals", createBody("eval-config-a"));
  check("POST /api/public/evals → 200 + id", c1.status === 200 && typeof c1.body?.id === "string", c1);
  const evalConfigId = c1.body.id;

  // Same scoreName → version increments
  const c2 = await api("POST", "/api/public/evals", createBody("eval-config-b"));
  check("second same-scoreName eval → version=2", c2.status === 200 && c2.body?.version === 2, c2);

  const list = await api("GET", "/api/public/evals");
  check("GET /api/public/evals lists configs", list.status === 200 && (list.body?.data ?? []).length >= 2, list.body);
  const alias = await api("GET", "/api/public/evals/configs");
  check("GET /api/public/evals/configs alias works", alias.status === 200, alias);

  const got = await api("GET", `/api/public/evals/${evalConfigId}`);
  check("GET /api/public/evals/{id} → 200", got.status === 200 && got.body?.id === evalConfigId, got);

  const patched = await api("PATCH", `/api/public/evals/${evalConfigId}`, { sampling: 0.5 });
  check("PATCH eval config → 200", patched.status === 200 && patched.body?.sampling === 0.5, patched);

  const missing = await api("GET", `/api/public/evals/nope-${runId}`);
  check("GET unknown eval config → 404", missing.status === 404, missing);

  const del = await api("DELETE", `/api/public/evals/${evalConfigId}`);
  check("DELETE eval config → 200/204", del.status === 200 || del.status === 204, del);
  await sleep(2200); // GET is response-cached for 2s
  const afterDel = await api("GET", `/api/public/evals/${evalConfigId}`);
  check("eval config gone after DELETE → 404", afterDel.status === 404, afterDel);
}

// ---------------------------------------------------------------------------
// 5. Eval templates CRUD
// ---------------------------------------------------------------------------
async function testEvalTemplates() {
  section("Eval templates CRUD");

  const tplName = `eval-tpl-${runId}`;
  const t1 = await api("POST", "/api/public/evals/templates", {
    name: tplName,
    prompt: "Judge the output: {{output}}",
    model: "gpt-4o-mini",
    provider: "openai",
    modelParams: { temperature: 0 },
    vars: ["input", "output"],
    outputSchema: { type: "object", properties: { score: { type: "number" } } },
  });
  check("POST /api/public/evals/templates → 200 + id", t1.status === 200 && typeof t1.body?.id === "string", t1);
  const tplId = t1.body.id;

  // Same name → version increments
  const t2 = await api("POST", "/api/public/evals/templates", {
    name: tplName,
    prompt: "Judge: {{input}}",
    model: "gpt-4o-mini",
    provider: "openai",
  });
  check("second same-name template → version=2", t2.status === 200 && t2.body?.version === 2, t2);

  const list = await api("GET", "/api/public/evals/templates");
  check("GET /api/public/evals/templates lists", list.status === 200 && (list.body?.data ?? []).some((t) => t.id === tplId), list.body);

  const got = await api("GET", `/api/public/evals/templates/${tplId}`);
  check("GET template by id → 200", got.status === 200 && got.body?.id === tplId, got);

  const patched = await api("PATCH", `/api/public/evals/templates/${tplId}`, { prompt: "Updated judge prompt" });
  check("PATCH template → 200", patched.status === 200, patched);

  const missing = await api("GET", `/api/public/evals/templates/nope-${runId}`);
  check("GET unknown template → 404", missing.status === 404, missing);

  const del = await api("DELETE", `/api/public/evals/templates/${tplId}`);
  check("DELETE template → 200/204", del.status === 200 || del.status === 204, del);
  // GET on this endpoint is response-cached for 2s; wait it out before asserting the delete.
  await sleep(2200);
  const afterDel = await api("GET", `/api/public/evals/templates/${tplId}`);
  check("template gone after DELETE → 404", afterDel.status === 404, afterDel);
}

// ---------------------------------------------------------------------------
// 6. Datasets CRUD + runs + run items
// ---------------------------------------------------------------------------
async function testDatasets(ctx) {
  section("Datasets CRUD + runs + run items");

  const dsName = `eval-ds-${runId}`;
  const ds = await api("POST", "/api/public/datasets", { name: dsName, metadata: { purpose: "eval-e2e" } });
  check("POST /api/public/datasets → 200 + id", ds.status === 200 && typeof ds.body?.id === "string", ds);
  const datasetId = ds.body.id;

  const dup = await api("POST", "/api/public/datasets", { name: dsName });
  check("duplicate dataset name → 409", dup.status === 409, dup);

  const listDs = await api("GET", "/api/public/datasets");
  check("GET /api/public/datasets lists", listDs.status === 200 && listDs.body?.data?.some((d) => d.id === datasetId), listDs.body);

  const itemId = `eval-item-${runId}`;
  const item = await api("POST", `/api/public/datasets/${datasetId}/items`, {
    id: itemId,
    input: { question: "1+1?" },
    expectedOutput: "2",
  });
  // The endpoint returns an array of created items (SDK batch semantics).
  const itemBody = Array.isArray(item.body) ? item.body[0] : item.body;
  check("POST dataset items → 200 + id", item.status === 200 && typeof itemBody?.id === "string", item);

  // Versioning: POST same item id again → new version (input updated)
  const itemV2 = await api("POST", `/api/public/datasets/${datasetId}/items`, {
    id: itemId,
    input: { question: "1+1?", language: "en" },
  });
  check("same item id re-post → 200", itemV2.status === 200, itemV2);

  const items = await api("GET", `/api/public/datasets/${datasetId}/items`);
  const versions = items.body?.data?.filter((i) => i.id === itemId) ?? [];
  check("GET dataset items → current version only", versions.length === 1 && versions[0]?.input?.language === "en", items.body);

  // Runs
  const run = await api("POST", `/api/public/datasets/${datasetId}/runs`, {
    name: `eval-run-${runId}`,
    description: "e2e run",
  });
  check("POST dataset runs → 200 + id", run.status === 200 && typeof run.body?.id === "string", run);
  const runId2 = run.body.id;

  const runs = await api("GET", `/api/public/datasets/${datasetId}/runs`);
  check("GET dataset runs lists", runs.status === 200 && runs.body?.data?.some((r) => r.id === runId2), runs.body);

  // Run items via the public REST endpoint (upstream `datasetRunItems_create`).
  // The ingestion dataset-run-item-create event is internal-only and rejected.
  const runItemName = `eval-run-${runId}`; // reuse the run created above
  const riCreate = await api("POST", "/api/public/dataset-run-items", {
    runName: runItemName,
    runDescription: "e2e run item",
    datasetItemId: itemId,
    traceId: ctx.traceId,
  });
  check("POST /api/public/dataset-run-items → 200 + id", riCreate.status === 200 && typeof riCreate.body?.id === "string", riCreate);
  check("run item response carries datasetRunId/datasetRunName", riCreate.status === 200 && riCreate.body?.datasetRunName === runItemName && typeof riCreate.body?.datasetRunId === "string", riCreate.body);

  // Same runName again → reuses the run (no conflict, no duplicate run)
  const riCreate2 = await api("POST", "/api/public/dataset-run-items", {
    runName: runItemName,
    datasetItemId: itemId,
    traceId: ctx.traceId,
  });
  check("same runName re-post → 200, run reused", riCreate2.status === 200 && riCreate2.body?.datasetRunId === riCreate.body?.datasetRunId, riCreate2);

  // Unknown datasetItemId → 404
  const riMissing = await api("POST", "/api/public/dataset-run-items", {
    runName: `nope-run-${runId}`,
    datasetItemId: "no-such-item",
    traceId: ctx.traceId,
  });
  check("run-item with unknown datasetItemId → 404", riMissing.status === 404, riMissing);

  // Neither traceId nor a resolvable observationId → 400
  const riNoTrace = await api("POST", "/api/public/dataset-run-items", {
    runName: `nope-run2-${runId}`,
    datasetItemId: itemId,
  });
  check("run-item without traceId/observationId → 400", riNoTrace.status === 400, riNoTrace);

  // traceId inferred from observationId when omitted (older SDKs); a new
  // runName auto-creates the run.
  const inferRunName = `eval-runitem-infer-${runId}`;
  const riInfer = await api("POST", "/api/public/dataset-run-items", {
    runName: inferRunName,
    datasetItemId: itemId,
    observationId: ctx.observationId,
  });
  check("traceId inferred from observationId → 200", riInfer.status === 200 && riInfer.body?.traceId === ctx.traceId, riInfer);
  check("new runName auto-created a run", riInfer.status === 200 && typeof riInfer.body?.datasetRunId === "string", riInfer.body);
  await sleep(2200); // GET runs list is response-cached for 2s
  const inferRuns = await api("GET", `/api/public/datasets/${datasetId}/runs`);
  check("auto-created run is listed", inferRuns.status === 200 && (inferRuns.body?.data ?? []).some((r) => r.name === inferRunName), inferRuns.body);

  // The ingestion event stays internal-only on the public API
  const ingest = await api("POST", "/api/public/ingestion", {
    batch: [{
      id: `eval-runitem-rejected-${runId}`,
      type: "dataset-run-item-create",
      timestamp: new Date().toISOString(),
      body: {
        traceId: ctx.traceId,
        datasetId,
        runId: runId2,
        datasetItemId: itemId,
        datasetVersion: null,
      },
    }],
  });
  // Ingestion reports per-event results as 207; the run-item event must fail
  // with 400 (internal-only usage).
  const ingestErr = ingest.body?.errors?.[0];
  check(
    "public ingestion rejects dataset-run-item-create",
    ingest.status === 207 && ingestErr?.status === 400,
    ingest.body,
  );

  await sleep(500);

  // Run detail now includes the run item with score join
  const runDetail = await api("GET", `/api/public/datasets/${datasetId}/runs/${runId2}`);
  check("GET run detail → 200 with items", runDetail.status === 200, runDetail);
  const runItems = runDetail.body?.items ?? runDetail.body?.data ?? [];
  const ri = Array.isArray(runItems) ? runItems.find((x) => x?.datasetItemId === itemId) : undefined;
  check("run detail contains our run item", ri !== undefined, runDetail.body);
  if (ri) {
    check("run item carries traceId", ri.traceId === ctx.traceId, ri);
    check("run item scores joined (≥1 from SDK scores)", Array.isArray(ri.scores) && ri.scores.length >= 1, ri);
  }

  const missingRun = await api("GET", `/api/public/datasets/${datasetId}/runs/nope-${runId}`);
  check("GET unknown run → 404", missingRun.status === 404, missingRun);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Langfuse SDK Eval E2E — BASE=${BASE} run=${runId}`);
  await testAuthNegatives();
  const ctx = await testSdkScores();
  await testScoreConfigsAndPostScores(ctx);
  await testEvalConfigs();
  await testEvalTemplates();
  await testDatasets(ctx);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("ALL EVAL E2E CHECKS PASSED");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
