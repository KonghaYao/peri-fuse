/**
 * Seed script — injects realistic sample traces/observations/scores into the
 * running lite server (http://localhost:23432) so the UI can be exercised.
 * Run: node scripts/seed.mjs
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:23432";

async function manage(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// 1. Find (or create) the demo project.
const projects = await manage("/api/manage/projects");
let project = projects.find((p) => p.name === "demo");
if (!project) {
  project = await manage("/api/manage/projects", {
    method: "POST",
    body: JSON.stringify({ name: "demo" }),
  });
}

// 2. Activate to obtain credentials.
const ctx = await manage(`/api/manage/projects/${project.id}/activate`, { method: "POST" });
const auth = `Basic ${Buffer.from(`${ctx.publicKey}:${ctx.secretKey}`).toString("base64")}`;
console.log(`Seeding project "${project.id}" ...`);

async function ingest(batch) {
  const res = await fetch(`${BASE}/api/public/ingestion`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ batch }),
  });
  if (!res.ok) throw new Error(`ingestion -> ${res.status}: ${await res.text()}`);
}

const NAMES = ["chat-completion", "rag-pipeline", "agent-run", "summarize-doc", "classify-intent"];
const USERS = ["user-alice", "user-bob", "user-carol", "user-dave"];
const ENVS = ["production", "staging"];
const MODELS = ["gpt-4o", "claude-3-5-sonnet", "gpt-4o-mini"];

function rand(n) {
  return Math.floor(Math.random() * n);
}
function pick(arr) {
  return arr[rand(arr.length)];
}

const batch = [];
const now = Date.now();

for (let i = 0; i < 40; i++) {
  const traceId = `seed-trace-${randomUUID()}`;
  const sessionId = i % 3 === 0 ? `seed-session-${i % 5}` : undefined;
  // Spread traces over the last 14 days.
  const ts = new Date(now - rand(14 * 24 * 3600 * 1000) - rand(3600 * 1000));
  const iso = ts.toISOString();
  const latencyMs = 300 + rand(4000);
  const endIso = new Date(ts.getTime() + latencyMs).toISOString();
  const name = pick(NAMES);

  batch.push({
    id: randomUUID(),
    type: "trace-create",
    timestamp: iso,
    body: {
      id: traceId,
      timestamp: iso,
      name,
      sessionId,
      userId: pick(USERS),
      tags: [name.split("-")[0], i % 2 === 0 ? "v2" : "v1"],
      environment: pick(ENVS),
      release: "2026.07",
      version: i % 4 === 0 ? "canary" : "stable",
      input: {
        messages: [{ role: "user", content: `Sample prompt #${i}: explain observability.` }],
      },
      output: {
        choices: [
          {
            role: "assistant",
            content: `Observability is measuring internal state from outputs. (trace ${i})`,
          },
        ],
      },
      metadata: { source: "seed-script", index: i },
    },
  });

  // A couple of observations per trace.
  const genId = `seed-gen-${randomUUID()}`;
  const spanId = `seed-span-${randomUUID()}`;
  batch.push({
    id: randomUUID(),
    type: "span-create",
    timestamp: iso,
    body: { id: spanId, traceId, name: "retrieval", startTime: iso, endTime: endIso },
  });
  batch.push({
    id: randomUUID(),
    type: "generation-create",
    timestamp: iso,
    body: {
      id: genId,
      traceId,
      parentObservationId: spanId,
      name: `${pick(MODELS)}-call`,
      startTime: iso,
      endTime: endIso,
      model: pick(MODELS),
      modelParameters: { temperature: 0.7 },
      usage: { input: 50 + rand(400), output: 20 + rand(300) },
      input: [{ role: "user", content: `Sample prompt #${i}` }],
      output: [{ role: "assistant", content: `Sample answer #${i}` }],
      level: i % 7 === 0 ? "WARNING" : "DEFAULT",
    },
  });

  // Occasional error event.
  if (i % 9 === 0) {
    batch.push({
      id: randomUUID(),
      type: "event-create",
      timestamp: iso,
      body: {
        id: `seed-evt-${randomUUID()}`,
        traceId,
        name: "exception",
        startTime: iso,
        level: "ERROR",
        statusMessage: "Upstream timeout",
      },
    });
  }

  // A score on roughly half the traces.
  if (i % 2 === 0) {
    batch.push({
      id: randomUUID(),
      type: "score-create",
      timestamp: iso,
      body: {
        id: `seed-score-${randomUUID()}`,
        traceId,
        name: "quality",
        value: Math.round(Math.random() * 100) / 100,
        source: "EVAL",
      },
    });
  }
}

// Ingest in chunks to avoid oversized payloads.
const CHUNK = 50;
for (let i = 0; i < batch.length; i += CHUNK) {
  await ingest(batch.slice(i, i + CHUNK));
}

console.log(`Done. Ingested ${batch.length} events across 40 traces.`);
