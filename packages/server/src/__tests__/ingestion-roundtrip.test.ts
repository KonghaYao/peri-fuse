/**
 * Ingestion -> query roundtrip over the public API.
 *
 * Pushes a small trace tree (trace + agent + generation + event + score)
 * through POST /api/public/ingestion and verifies it via the traces,
 * observations, and scores GET endpoints.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";

const runId = randomUUID();
const traceId = `rt-trace-${runId}`;
const agentId = `rt-agent-${runId}`;
const generationId = `rt-gen-${runId}`;
const eventId = `rt-event-${runId}`;
const scoreId = `rt-score-${runId}`;
const sessionId = `rt-session-${runId}`;
const scoreName = `rt-quality-${runId}`;

const now = new Date();
const iso = now.toISOString();
const laterIso = new Date(now.getTime() + 1500).toISOString();

describe("ingestion -> query roundtrip", () => {
  beforeAll(async () => {
    const res = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: {
            id: traceId,
            timestamp: iso,
            name: `rt-trace-name-${runId}`,
            sessionId,
            userId: `rt-user-${runId}`,
            tags: ["rt-tag-a", "rt-tag-b"],
            environment: "production",
            input: { question: "hello" },
            output: { answer: "world" },
          },
        },
        {
          id: randomUUID(),
          type: "agent-create",
          timestamp: iso,
          body: {
            id: agentId,
            traceId,
            name: "rt-agent",
            startTime: iso,
            endTime: laterIso,
          },
        },
        {
          id: randomUUID(),
          type: "generation-create",
          timestamp: iso,
          body: {
            id: generationId,
            traceId,
            parentObservationId: agentId,
            name: "rt-generation",
            startTime: iso,
            endTime: laterIso,
            model: "gpt-4o",
            usage: { input: 10, output: 5, total: 15 },
            input: [{ role: "user", content: "hi" }],
            output: [{ role: "assistant", content: "hey" }],
          },
        },
        {
          id: randomUUID(),
          type: "event-create",
          timestamp: iso,
          body: {
            id: eventId,
            traceId,
            parentObservationId: agentId,
            name: "rt-event",
            startTime: iso,
          },
        },
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: iso,
          body: {
            id: scoreId,
            traceId,
            name: scoreName,
            value: 0.9,
            dataType: "NUMERIC",
            comment: "roundtrip score",
          },
        },
      ],
    });

    expect(res.status).toBe(207);
    expect(res.body.errors).toEqual([]);
    expect(res.body.successes).toHaveLength(5);
  });

  it("returns the trace with its trace-level fields", async () => {
    const res = await apiGet(`/api/public/traces/${traceId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(traceId);
    expect(res.body.name).toBe(`rt-trace-name-${runId}`);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.userId).toBe(`rt-user-${runId}`);
    expect(res.body.tags).toEqual(["rt-tag-a", "rt-tag-b"]);
    expect(res.body.environment).toBe("production");
    expect(res.body.htmlPath).toContain(`/traces/${traceId}`);
  });

  it("embeds observations and scores in the single-trace response", async () => {
    const res = await apiGet(`/api/public/traces/${traceId}`);
    expect(res.status).toBe(200);

    const names = res.body.observations.map((o: any) => o.name).sort();
    expect(names).toEqual(["rt-agent", "rt-event", "rt-generation"]);

    const score = res.body.scores.find((s: any) => s.name === scoreName);
    expect(score).toBeDefined();
    expect(score.value).toBeCloseTo(0.9);
  });

  it("lists observations with type, nesting, and IO for the trace", async () => {
    const res = await apiGet(`/api/public/observations?traceId=${traceId}&limit=100`);
    expect(res.status).toBe(200);

    const byName = Object.fromEntries(res.body.data.map((o: any) => [o.name, o]));
    expect(byName["rt-agent"]?.type).toBe("AGENT");
    expect(byName["rt-generation"]?.type).toBe("GENERATION");
    expect(byName["rt-event"]?.type).toBe("EVENT");

    expect(byName["rt-generation"]?.parentObservationId).toBe(agentId);
    expect(byName["rt-event"]?.parentObservationId).toBe(agentId);
    expect(byName["rt-agent"]?.parentObservationId).toBeNull();

    expect(byName["rt-generation"]?.model).toBe("gpt-4o");
    expect(byName["rt-generation"]?.input).toEqual([{ role: "user", content: "hi" }]);
    expect(byName["rt-generation"]?.output).toEqual([{ role: "assistant", content: "hey" }]);
    expect(byName["rt-generation"]?.usageDetails).toMatchObject({
      input: 10,
      output: 5,
      total: 15,
    });
  });

  it("finds the score via the scores endpoint (traceId param)", async () => {
    const res = await apiGet(`/api/public/scores?traceId=${traceId}`);
    expect(res.status).toBe(200);
    const score = res.body.data.find((s: any) => s.name === scoreName);
    expect(score).toBeDefined();
    expect(score.traceId).toBe(traceId);
    expect(score.value).toBeCloseTo(0.9);
    expect(score.dataType).toBe("NUMERIC");
  });

  it("returns 404 for an unknown trace id", async () => {
    const res = await apiGet(`/api/public/traces/does-not-exist-${runId}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toContain("not found");
  });
});
