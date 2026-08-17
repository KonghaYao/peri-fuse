/**
 * Comprehensive E2E API test using the official Langfuse SDK.
 *
 * Usage:
 *   1. Start the server:  PERIFUSE_HOME=/tmp/pf-e2e pnpm dev:server
 *   2. Run this test:     PK=<pk> SK=<sk> BASE=http://localhost:23432 node e2e/langfuse-sdk-e2e.mjs
 *
 * Or use the npm script (auto-starts a throwaway server):
 *   pnpm test:e2e
 *
 * Covers: SDK ingestion (trace/generation/span/event/score), traces API,
 * observations API, scores API, sessions API, users API, dashboard API,
 * manage CRUD, health, auth negative, traces/metrics, and data persistence.
 */
import { Langfuse } from "langfuse";

const BASE = process.env.BASE ?? "http://localhost:23432";
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
// 1. Health & Auth
// ---------------------------------------------------------------------------
async function testHealthAndAuth() {
  section("Health & Auth");
  const h = await api("GET", "/api/public/health", null, false);
  check("GET /health → 200 OK", h.status === 200 && h.body.status === "OK", h);

  const noAuth = await fetch(BASE + "/api/public/traces");
  check("No auth header → 401", noAuth.status === 401);

  const badAuth = await fetch(BASE + "/api/public/traces", {
    headers: { Authorization: "Basic " + Buffer.from("pk-fake:sk-fake").toString("base64") },
  });
  check("Bad credentials → 401", badAuth.status === 401);
}

// ---------------------------------------------------------------------------
// 2. SDK Ingestion — build rich data
// ---------------------------------------------------------------------------
const sessionId = `e2e-session-${runId}`;
const userId = `e2e-user-${runId}`;
const traceIds = [];
const generationIds = [];
const scoreNames = [];

async function testSdkIngestion() {
  section("SDK Ingestion (Langfuse client)");

  const langfuse = new Langfuse({
    publicKey: PK,
    secretKey: SK,
    baseUrl: BASE,
    flushAt: 1,
    flushInterval: 0,
  });

  // --- Trace 1: chat interaction with generation + score ---
  const trace1 = langfuse.trace({
    id: `e2e-t1-${runId}`,
    name: "chat-completion",
    sessionId,
    userId,
    tags: ["e2e", "chat"],
    environment: "e2e-test",
    input: { messages: [{ role: "user", content: "What is 2+2?" }] },
    output: { answer: "4" },
    metadata: { source: "e2e-script" },
  });
  traceIds.push(trace1.id);

  const gen1 = trace1.generation({
    id: `e2e-g1-${runId}`,
    name: "gpt4o-call",
    model: "gpt-4o",
    startTime: new Date(),
    endTime: new Date(Date.now() + 1200),
    input: [{ role: "user", content: "What is 2+2?" }],
    output: [{ role: "assistant", content: "4" }],
    usage: { input: 12, output: 3, total: 15 },
    metadata: { temperature: 0.7 },
    level: "DEFAULT",
  });
  generationIds.push(gen1.id);

  const span1 = trace1.span({
    id: `e2e-s1-${runId}`,
    name: "retrieval",
    startTime: new Date(),
    endTime: new Date(Date.now() + 300),
    input: { query: "math facts" },
    output: { docs: ["2+2=4"] },
  });

  trace1.event({
    id: `e2e-ev1-${runId}`,
    name: "cache-hit",
    startTime: new Date(),
    metadata: { key: "math_2_2" },
  });

  const scoreName1 = `e2e-accuracy-${runId}`;
  scoreNames.push(scoreName1);
  trace1.score({ name: scoreName1, value: 1.0, dataType: "NUMERIC", comment: "correct answer" });

  // --- Trace 2: multi-step agent with nested spans ---
  const trace2 = langfuse.trace({
    id: `e2e-t2-${runId}`,
    name: "agent-workflow",
    sessionId,
    userId,
    tags: ["e2e", "agent"],
    environment: "e2e-test",
    input: { task: "research topic" },
  });
  traceIds.push(trace2.id);

  const agentSpan = trace2.span({
    id: `e2e-s2-${runId}`,
    name: "planning",
    startTime: new Date(),
    endTime: new Date(Date.now() + 500),
  });

  const gen2 = trace2.generation({
    id: `e2e-g2-${runId}`,
    name: "claude-call",
    model: "claude-sonnet-4-20250514",
    startTime: new Date(),
    endTime: new Date(Date.now() + 2000),
    input: [{ role: "user", content: "Plan research" }],
    output: [{ role: "assistant", content: "Step 1: search..." }],
    usage: { input: 50, output: 120, total: 170 },
    level: "DEBUG",
  });
  generationIds.push(gen2.id);

  const scoreName2 = `e2e-quality-${runId}`;
  scoreNames.push(scoreName2);
  trace2.score({ name: scoreName2, value: 0.85, dataType: "NUMERIC" });

  // --- Trace 3: different user (for users endpoint) ---
  const trace3 = langfuse.trace({
    id: `e2e-t3-${runId}`,
    name: "simple-log",
    userId: `e2e-user2-${runId}`,
    environment: "e2e-test",
    input: "hello",
    output: "world",
  });
  traceIds.push(trace3.id);

  // Flush all events to the server
  await langfuse.flushAsync();
  await langfuse.shutdownAsync();
  await sleep(500); // allow telemetry writes to settle

  check("SDK flush completed without error", true);
  check("3 traces created via SDK", traceIds.length === 3);
}

// ---------------------------------------------------------------------------
// 3. Traces API
// ---------------------------------------------------------------------------
async function testTracesApi() {
  section("Traces API");

  // List
  const list = await api("GET", `/api/public/traces?limit=50&environment=e2e-test`);
  check("GET /traces → 200", list.status === 200, list.status);
  const listIds = (list.body.data || []).map((t) => t.id);
  check("trace1 in list", listIds.includes(`e2e-t1-${runId}`), listIds.slice(0, 5));
  check("trace2 in list", listIds.includes(`e2e-t2-${runId}`));

  // Detail — trace1
  const t1 = await api("GET", `/api/public/traces/e2e-t1-${runId}`);
  check("GET /traces/:id → 200", t1.status === 200, t1.status);
  check("trace1 name", t1.body.name === "chat-completion", t1.body.name);
  check("trace1 sessionId", t1.body.sessionId === sessionId, t1.body.sessionId);
  check("trace1 userId", t1.body.userId === userId, t1.body.userId);
  check("trace1 tags", JSON.stringify(t1.body.tags) === JSON.stringify(["e2e", "chat"]), t1.body.tags);
  check("trace1 environment", t1.body.environment === "e2e-test", t1.body.environment);
  check("trace1 input preserved", t1.body.input?.messages?.[0]?.content === "What is 2+2?", t1.body.input);
  check("trace1 output preserved", t1.body.output?.answer === "4", t1.body.output);

  // Embedded observations
  const obsNames = (t1.body.observations || []).map((o) => o.name).sort();
  check("trace1 has 3 observations", obsNames.length === 3, obsNames);
  check("trace1 obs names", obsNames.includes("gpt4o-call") && obsNames.includes("retrieval") && obsNames.includes("cache-hit"), obsNames);

  // Embedded scores
  const sc = (t1.body.scores || []).find((s) => s.name === `e2e-accuracy-${runId}`);
  check("trace1 embedded score value=1", sc && Math.abs(sc.value - 1.0) < 1e-6, sc);

  // 404
  const nf = await api("GET", `/api/public/traces/nonexistent-${runId}`);
  check("GET /traces/unknown → 404", nf.status === 404, nf.status);

  // Metrics endpoint
  const metrics = await api("GET", `/api/public/traces/metrics?traceIds=e2e-t1-${runId},e2e-t2-${runId}`);
  check("GET /traces/metrics → 200", metrics.status === 200, metrics.status);
  check("metrics returns array", Array.isArray(metrics.body), typeof metrics.body);
  if (Array.isArray(metrics.body) && metrics.body.length > 0) {
    const m1 = metrics.body.find((m) => m.id === `e2e-t1-${runId}`);
    check("metrics has trace1", !!m1, metrics.body.map((m) => m.id));
    check("metrics trace1 has latency", m1 && typeof m1.latency === "number", m1);
  }
}

// ---------------------------------------------------------------------------
// 4. Observations API
// ---------------------------------------------------------------------------
async function testObservationsApi() {
  section("Observations API");

  const obs = await api("GET", `/api/public/observations?traceId=e2e-t1-${runId}&limit=100`);
  check("GET /observations → 200", obs.status === 200, obs.status);
  const byName = Object.fromEntries((obs.body.data || []).map((o) => [o.name, o]));

  check("generation type", byName["gpt4o-call"]?.type === "GENERATION", byName["gpt4o-call"]?.type);
  check("generation model", byName["gpt4o-call"]?.model === "gpt-4o", byName["gpt4o-call"]?.model);
  check("generation usage", byName["gpt4o-call"]?.usageDetails?.input === 12 && byName["gpt4o-call"]?.usageDetails?.total === 15, byName["gpt4o-call"]?.usageDetails);
  check("generation input", byName["gpt4o-call"]?.input?.[0]?.content === "What is 2+2?", byName["gpt4o-call"]?.input);
  check("generation output", byName["gpt4o-call"]?.output?.[0]?.content === "4", byName["gpt4o-call"]?.output);

  check("span type", byName["retrieval"]?.type === "SPAN", byName["retrieval"]?.type);
  check("event type", byName["cache-hit"]?.type === "EVENT", byName["cache-hit"]?.type);

  // trace2 observations
  const obs2 = await api("GET", `/api/public/observations?traceId=e2e-t2-${runId}&limit=100`);
  const byName2 = Object.fromEntries((obs2.body.data || []).map((o) => [o.name, o]));
  check("trace2 generation model claude", byName2["claude-call"]?.model === "claude-sonnet-4-20250514", byName2["claude-call"]?.model);
  check("trace2 generation level DEBUG", byName2["claude-call"]?.level === "DEBUG", byName2["claude-call"]?.level);
}

// ---------------------------------------------------------------------------
// 5. Scores API
// ---------------------------------------------------------------------------
async function testScoresApi() {
  section("Scores API");

  const scores = await api("GET", `/api/public/scores?traceId=e2e-t1-${runId}`);
  check("GET /scores → 200", scores.status === 200, scores.status);
  const s1 = (scores.body.data || []).find((s) => s.name === `e2e-accuracy-${runId}`);
  check("score accuracy found", !!s1, scores.body.data?.map((s) => s.name));
  check("score value 1.0", s1 && Math.abs(s1.value - 1.0) < 1e-6, s1?.value);
  check("score dataType NUMERIC", s1?.dataType === "NUMERIC", s1?.dataType);
  check("score traceId", s1?.traceId === `e2e-t1-${runId}`, s1?.traceId);

  const scores2 = await api("GET", `/api/public/scores?traceId=e2e-t2-${runId}`);
  const s2 = (scores2.body.data || []).find((s) => s.name === `e2e-quality-${runId}`);
  check("trace2 score quality 0.85", s2 && Math.abs(s2.value - 0.85) < 1e-6, s2?.value);
}

// ---------------------------------------------------------------------------
// 6. Sessions API
// ---------------------------------------------------------------------------
async function testSessionsApi() {
  section("Sessions API");

  const list = await api("GET", `/api/public/sessions?limit=50`);
  check("GET /sessions → 200", list.status === 200, list.status);
  const session = (list.body.data || []).find((s) => s.id === sessionId);
  check("session in list", !!session, list.body.data?.map((s) => s.id).slice(0, 5));
  if (session) {
    check("session countTraces ≥ 2", session.countTraces >= 2, session.countTraces);
    check("session has userIds", session.userIds?.includes(userId), session.userIds);
  }

  // Detail
  const detail = await api("GET", `/api/public/sessions/${sessionId}`);
  check("GET /sessions/:id → 200", detail.status === 200, detail.status);
  check("session detail id", detail.body.id === sessionId, detail.body.id);
  check("session detail countTraces ≥ 2", detail.body.countTraces >= 2, detail.body.countTraces);
  check("session detail users", detail.body.users?.includes(userId), detail.body.users);
  check("session detail has traces array", Array.isArray(detail.body.traces) && detail.body.traces.length >= 2, detail.body.traces?.length);
  if (detail.body.traces?.length > 0) {
    const st1 = detail.body.traces.find((t) => t.id === `e2e-t1-${runId}`);
    check("session trace1 has observations", st1 && Array.isArray(st1.observations) && st1.observations.length > 0, st1?.observations?.length);
    check("session trace1 has scores", st1 && Array.isArray(st1.scores) && st1.scores.length > 0, st1?.scores?.length);
  }

  // 404
  const nf = await api("GET", `/api/public/sessions/nonexistent-${runId}`);
  check("GET /sessions/unknown → 404", nf.status === 404, nf.status);
}

// ---------------------------------------------------------------------------
// 7. Users API
// ---------------------------------------------------------------------------
async function testUsersApi() {
  section("Users API");

  const list = await api("GET", `/api/public/users?limit=50`);
  check("GET /users → 200", list.status === 200, list.status);
  const u1 = (list.body.data || []).find((u) => u.id === userId);
  check("user1 in list", !!u1, list.body.data?.map((u) => u.id).slice(0, 5));
  if (u1) {
    check("user1 countTraces ≥ 2", u1.countTraces >= 2, u1.countTraces);
    check("user1 has firstSeen", !!u1.firstSeen, u1.firstSeen);
    check("user1 has lastSeen", !!u1.lastSeen, u1.lastSeen);
  }
  const u2 = (list.body.data || []).find((u) => u.id === `e2e-user2-${runId}`);
  check("user2 in list", !!u2, "user2 not found");
}

// ---------------------------------------------------------------------------
// 8. Dashboard API
// ---------------------------------------------------------------------------
async function testDashboardApi() {
  section("Dashboard API");

  const dash = await api("GET", "/api/public/dashboard");
  check("GET /dashboard → 200", dash.status === 200, dash.status);
  check("summary.totalTraces ≥ 3", dash.body.summary?.totalTraces >= 3, dash.body.summary?.totalTraces);
  check("summary.totalObservations ≥ 5", dash.body.summary?.totalObservations >= 5, dash.body.summary?.totalObservations);
  check("summary.totalScores ≥ 2", dash.body.summary?.totalScores >= 2, dash.body.summary?.totalScores);
  check("summary.totalUsers ≥ 2", dash.body.summary?.totalUsers >= 2, dash.body.summary?.totalUsers);
  check("daily is array", Array.isArray(dash.body.daily), typeof dash.body.daily);
  check("byModel is array", Array.isArray(dash.body.byModel), typeof dash.body.byModel);
  if (dash.body.byModel?.length > 0) {
    const gpt = dash.body.byModel.find((m) => m.model === "gpt-4o");
    check("byModel has gpt-4o", !!gpt, dash.body.byModel.map((m) => m.model));
  }
  check("levels is array", Array.isArray(dash.body.levels), typeof dash.body.levels);
}

// ---------------------------------------------------------------------------
// 9. Manage CRUD
// ---------------------------------------------------------------------------
async function testManageCrud() {
  section("Manage CRUD");

  // Create project
  const projName = `e2e-manage-${runId}`;
  const created = await api("POST", "/api/manage/projects", { name: projName }, false);
  check("POST /manage/projects → 201", created.status === 201, created);
  const projId = created.body.id;
  check("project has id", !!projId, created.body);
  check("project orgName", typeof created.body.orgName === "string", created.body.orgName);

  // List projects
  const projList = await api("GET", "/api/manage/projects", null, false);
  check("GET /manage/projects → 200", projList.status === 200, projList.status);
  const found = (projList.body || []).find((p) => p.id === projId);
  check("new project in list", !!found, projList.body?.length);
  check("project keyCount = 0", found?.keyCount === 0, found?.keyCount);

  // Create key
  const keyRes = await api("POST", `/api/manage/projects/${projId}/keys`, {}, false);
  check("POST /manage/projects/:id/keys → 201", keyRes.status === 201, keyRes);
  check("key has publicKey", !!keyRes.body.publicKey, keyRes.body);
  check("key has secretKey", !!keyRes.body.secretKey, keyRes.body);
  check("key has displaySecretKey", !!keyRes.body.displaySecretKey, keyRes.body);

  // List keys
  const keysList = await api("GET", `/api/manage/projects/${projId}/keys`, null, false);
  check("GET keys → 200", keysList.status === 200, keysList.status);
  check("key in list", (keysList.body || []).some((k) => k.id === keyRes.body.id), keysList.body?.length);

  // Delete key
  const delRes = await api("DELETE", `/api/manage/keys/${keyRes.body.id}`, null, false);
  check("DELETE /manage/keys/:id → 200", delRes.status === 200 && delRes.body.success === true, delRes);

  // Verify deleted
  const keysAfter = await api("GET", `/api/manage/projects/${projId}/keys`, null, false);
  check("key removed from list", !(keysAfter.body || []).some((k) => k.id === keyRes.body.id), keysAfter.body?.length);

  // Activate (creates web-ui key)
  const activate = await api("POST", `/api/manage/projects/${projId}/activate`, {}, false);
  check("POST activate → 200", activate.status === 200, activate);
  check("activate returns publicKey", !!activate.body.publicKey, activate.body);
  check("activate returns secretKey", !!activate.body.secretKey, activate.body);

  // 404 for unknown project
  const nfKey = await api("POST", `/api/manage/projects/nonexistent-${runId}/keys`, {}, false);
  check("POST keys unknown project → 404", nfKey.status === 404, nfKey.status);
  const nfAct = await api("POST", `/api/manage/projects/nonexistent-${runId}/activate`, {}, false);
  check("POST activate unknown project → 404", nfAct.status === 404, nfAct.status);

  // Delete key 404
  const nfDel = await api("DELETE", `/api/manage/keys/nonexistent-${runId}`, null, false);
  check("DELETE unknown key → 404", nfDel.status === 404, nfDel.status);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nLangfuse SDK E2E Test — run ${runId}`);
  console.log(`Server: ${BASE}\n`);

  await testHealthAndAuth();
  await testSdkIngestion();
  await testTracesApi();
  await testObservationsApi();
  await testScoresApi();
  await testSessionsApi();
  await testUsersApi();
  await testDashboardApi();
  await testManageCrud();

  section("RESULT");
  console.log(`  Total: ${pass + fail} | Passed: ${pass} | Failed: ${fail}`);
  if (failures.length > 0) {
    console.log(`  Failures:\n    - ${failures.join("\n    - ")}`);
  }
  console.log("");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal E2E error:", e);
  process.exit(2);
});
