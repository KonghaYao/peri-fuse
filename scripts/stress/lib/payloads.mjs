/**
 * Realistic ingestion payload generators for stress tests.
 *
 * Produces Langfuse-shaped ingestion events (trace + span + generation +
 * optional score/error), mirroring scripts/seed.mjs but parameterized and
 * optimized for high-volume generation. Generations carry cache token usage
 * (`input_cached_tokens` / `input_cache_creation`) so the cache-token
 * aggregation and materialized columns are exercised under load.
 */

const NAMES = [
  "chat-completion",
  "rag-pipeline",
  "agent-run",
  "summarize-doc",
  "classify-intent",
  "embed-query",
];
const USERS = ["user-alice", "user-bob", "user-carol", "user-dave", "user-erin", "user-frank"];
const ENVS = ["production", "staging"];
const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-3-5-sonnet",
  "claude-3-haiku",
  "deepseek-v4-flash",
];

let idCounter = 0;

/** Fast unique id (avoids randomUUID overhead at high volume). */
export function nextId(prefix) {
  idCounter++;
  return `${prefix}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rand(n) {
  return Math.floor(Math.random() * n);
}
function pick(arr) {
  return arr[rand(arr.length)];
}

/**
 * Build the ingestion events for a single trace.
 * Returns an array of events (trace-create, span-create, generation-create,
 * and optionally score-create / event-create).
 *
 * Options:
 *  - cache: include cache token usage on the generation (default true)
 *  - score: attach a score (default ~50% of traces)
 *  - error: attach an error event (default ~10% of traces)
 *  - session: assign a sessionId (default ~33% of traces)
 *  - ts: base timestamp ms (default now)
 */
export function traceEvents(opts = {}) {
  const { cache = true, ts = Date.now() } = opts;
  const score = opts.score ?? Math.random() < 0.5;
  const error = opts.error ?? Math.random() < 0.1;
  const session = opts.session ?? Math.random() < 0.33;

  const traceId = nextId("st-trace");
  const iso = new Date(ts).toISOString();
  const latencyMs = 200 + rand(3000);
  const endIso = new Date(ts + latencyMs).toISOString();
  const name = pick(NAMES);

  const events = [];

  events.push({
    id: nextId("evt"),
    type: "trace-create",
    timestamp: iso,
    body: {
      id: traceId,
      timestamp: iso,
      name,
      sessionId: session ? `st-session-${rand(200)}` : undefined,
      userId: pick(USERS),
      tags: [name.split("-")[0], rand(2) === 0 ? "v2" : "v1"],
      environment: pick(ENVS),
      release: "2026.08",
      input: { messages: [{ role: "user", content: `stress prompt ${traceId}` }] },
      output: { choices: [{ role: "assistant", content: `stress answer ${traceId}` }] },
      metadata: { source: "stress", traceId },
    },
  });

  const spanId = nextId("st-span");
  events.push({
    id: nextId("evt"),
    type: "span-create",
    timestamp: iso,
    body: { id: spanId, traceId, name: "retrieval", startTime: iso, endTime: endIso },
  });

  const input = 50 + rand(800);
  const output = 20 + rand(600);
  // Cache usage: a realistic mix — most generations hit the cache partially.
  const cached = cache && Math.random() < 0.7 ? Math.floor(input * (0.3 + Math.random() * 0.6)) : 0;
  const creation = cache && cached === 0 && Math.random() < 0.3 ? Math.floor(input * 0.4) : 0;

  // Use the modern `usageDetails` field (an open record), NOT the legacy
  // `usage` field: the legacy `usage` schema is a closed object that strips
  // unknown keys such as input_cached_tokens, so cache usage would be lost.
  const usageDetails = { input, output };
  if (cached > 0) usageDetails.input_cached_tokens = cached;
  if (creation > 0) usageDetails.input_cache_creation = creation;

  events.push({
    id: nextId("evt"),
    type: "generation-create",
    timestamp: iso,
    body: {
      id: nextId("st-gen"),
      traceId,
      parentObservationId: spanId,
      name: `${pick(MODELS)}-call`,
      startTime: iso,
      endTime: endIso,
      model: pick(MODELS),
      modelParameters: { temperature: 0.7 },
      usageDetails,
      input: [{ role: "user", content: `stress prompt ${traceId}` }],
      output: [{ role: "assistant", content: `stress answer ${traceId}` }],
      level: error ? "WARNING" : "DEFAULT",
    },
  });

  if (error) {
    events.push({
      id: nextId("evt"),
      type: "event-create",
      timestamp: iso,
      body: {
        id: nextId("st-evt"),
        traceId,
        name: "exception",
        startTime: iso,
        level: "ERROR",
        statusMessage: "Upstream timeout (stress)",
      },
    });
  }

  if (score) {
    // Most SDK callers use `score({ name, value, traceId })` and omit dataType,
    // letting the server infer it (number → NUMERIC). We mostly do the same so
    // the load exercises that inference path, but occasionally send dataType
    // explicitly to cover both code paths.
    const scoreBody = {
      id: nextId("st-score"),
      traceId,
      name: "quality",
      value: Math.round(Math.random() * 100) / 100,
      source: "EVAL",
    };
    if (Math.random() < 0.3) scoreBody.dataType = "NUMERIC";
    events.push({
      id: nextId("evt"),
      type: "score-create",
      timestamp: iso,
      body: scoreBody,
    });
  }

  return events;
}

/**
 * Build a full ingestion batch of `traces` traces.
 * Returns { batch, eventCount } ready to POST to /api/public/ingestion.
 */
export function makeBatch({ traces = 5, cache = true } = {}) {
  const batch = [];
  const now = Date.now();
  for (let i = 0; i < traces; i++) {
    batch.push(...traceEvents({ cache, ts: now - rand(5000) }));
  }
  return { batch, eventCount: batch.length };
}
