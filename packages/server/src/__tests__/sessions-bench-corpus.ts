/**
 * Corpus generator for the session list query-plan benchmark
 * (`sessions-query-plan.test.ts`).
 *
 * Seeds a dedicated project with `PERIFUSE_BENCH_SESSIONS` (default 200)
 * sessions x 5 traces, spread over 30 days. Traces carry varied user ids, tags
 * and environments; 90% of them get one generation observation so the
 * materialized `trace_metrics` rows exist, and one session deliberately has no
 * observations at all (NULL cost sums).
 */
import { randomUUID } from "node:crypto";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import type { Hono } from "hono";
import type { LiteServerEnv } from "../auth";
import { getApp } from "./helpers";
import { createSecondProject } from "./second-project";

export const SESSION_COUNT = Number(process.env.PERIFUSE_BENCH_SESSIONS ?? "") || 200;
export const TRACES_PER_SESSION = 5;
export const TRACE_COUNT = SESSION_COUNT * TRACES_PER_SESSION;

const DAY_MS = 86_400_000;
/** Tags every trace draws from — the filter matrix references these. */
export const TAG_POOL = ["bench-alpha", "bench-beta", "bench-gamma", "bench-delta"];

export type SessionCorpus = { projectId: string; auth: string };

function corpusTrace(index: number): Record<string, unknown> {
  const timestamp = new Date(Date.UTC(2026, 0, 1) + (index % 30) * DAY_MS + index * 1_000);
  const tags =
    index % 4 === 0
      ? []
      : index % 3 === 0
        ? [TAG_POOL[index % TAG_POOL.length], TAG_POOL[(index + 1) % TAG_POOL.length]]
        : [TAG_POOL[index % TAG_POOL.length]];
  const environment = index % 5 === 0 ? "production" : index % 7 === 0 ? "staging" : "default";
  const userId =
    index % 10 === 0 ? null : index % 97 === 0 ? "bench,user,comma" : `bench-user-${index % 7}`;
  return {
    id: randomUUID(),
    type: "trace-create",
    timestamp: timestamp.toISOString(),
    body: {
      id: `bench-trace-${index}`,
      sessionId: `bench-session-${String(Math.floor(index / TRACES_PER_SESSION)).padStart(3, "0")}`,
      timestamp: timestamp.toISOString(),
      userId,
      tags,
      environment,
    },
  };
}

/** 90% of traces carry an observation; session 2 has none (NULL metric path). */
function corpusObservation(index: number): Record<string, unknown> | null {
  if (index % 10 === 9 || Math.floor(index / TRACES_PER_SESSION) === 2) return null;
  const timestamp = new Date(Date.UTC(2026, 0, 1) + (index % 30) * DAY_MS + index * 1_000);
  const input = 10 + (index % 50);
  const output = 5 + (index % 20);
  return {
    id: randomUUID(),
    type: "generation-create",
    timestamp: timestamp.toISOString(),
    body: {
      id: `bench-observation-${index}`,
      traceId: `bench-trace-${index}`,
      startTime: timestamp.toISOString(),
      endTime: new Date(timestamp.getTime() + 500).toISOString(),
      model: "bench-model",
      usageDetails: {
        input,
        output,
        total: input + output,
        ...(index % 3 === 0 ? { cached_tokens: 3 } : {}),
      },
      costDetails: {
        input: Number((0.001 * (index % 5)).toFixed(6)),
        output: 0.002,
        total: Number((0.001 * (index % 5) + 0.002).toFixed(6)),
      },
    },
  };
}

/** Ingests the corpus through the public ingestion API of a fresh project. */
export async function seedSessionCorpus(): Promise<SessionCorpus> {
  const project = await createSecondProject();
  const app: Hono<LiteServerEnv> = getApp();
  let batch: unknown[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      headers: { Authorization: project.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ batch }),
    });
    const body = (await res.json()) as { errors?: unknown[] };
    if (res.status !== 207 || (body.errors?.length ?? 0) > 0)
      throw new Error(
        `benchmark ingestion failed with status ${res.status}: ${JSON.stringify(body).slice(0, 500)}`,
      );
    batch = [];
  };
  for (let index = 0; index < TRACE_COUNT; index++) {
    batch.push(corpusTrace(index));
    const observation = corpusObservation(index);
    if (observation) batch.push(observation);
    if (batch.length >= 200) await flush();
  }
  await flush();
  // Soft-delete one trace in sessions 0 and 2 (the metrics-less session): both
  // queries must exclude them from the aggregates and from the page.
  const deleted = await getTelemetryDB().command({
    query: "UPDATE traces SET is_deleted = 1 WHERE id IN ('bench-trace-1', 'bench-trace-11')",
    params: {},
  });
  if (deleted.changes !== 2)
    throw new Error(`expected 2 soft-deleted traces, updated ${deleted.changes}`);
  return { projectId: project.projectId, auth: project.auth };
}
