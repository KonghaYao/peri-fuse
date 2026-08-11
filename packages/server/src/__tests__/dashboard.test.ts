/**
 * Dashboard endpoint backed by the materialized daily rollups.
 *
 * Seeds a small trace tree across two days via the public ingestion API,
 * materializes the daily stats, then checks the dashboard figures for the
 * all-time window, a full-day window and a mid-day edge window.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { clearResponseCache } from "../response-cache";
import { apiGet, apiPost } from "./helpers";

const runId = randomUUID().slice(0, 8);

/** ISO instant `daysAgo` days back at `hour` UTC. */
function dayIso(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

const day1Morning = dayIso(3, 10);
const day1LateMorning = dayIso(3, 11);
const day2Morning = dayIso(1, 10);
const day1Day = dayIso(3, 0).slice(0, 10);
const day2Day = dayIso(1, 0).slice(0, 10);

const traceA = `dash-a-${runId}`;
const traceB = `dash-b-${runId}`;
const traceC = `dash-c-${runId}`;
const genA = `dash-ga-${runId}`;
const genB = `dash-gb-${runId}`;
const genC = `dash-gc-${runId}`;

function generationEvent(
  id: string,
  traceId: string,
  startIso: string,
  model: string,
  total: number,
  extra: Record<string, unknown> = {},
) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 2000).toISOString();
  return {
    id: randomUUID(),
    type: "generation-create",
    timestamp: startIso,
    body: {
      id,
      traceId,
      name: `gen-${id}`,
      startTime: startIso,
      endTime: end,
      model,
      usage: { input: Math.round(total / 3), output: total - Math.round(total / 3), total },
      ...extra,
    },
  };
}

function traceEvent(id: string, timestampIso: string, userId: string) {
  return {
    id: randomUUID(),
    type: "trace-create",
    timestamp: timestampIso,
    body: { id, timestamp: timestampIso, name: `dash-${id}`, userId },
  };
}

describe("dashboard (materialized daily stats)", () => {
  beforeAll(async () => {
    const res = await apiPost("/api/public/ingestion", {
      batch: [
        traceEvent(traceA, day1Morning, `dash-u1-${runId}`),
        generationEvent(genA, traceA, day1Morning, `dash-model-a-${runId}`, 150),
        traceEvent(traceB, day1LateMorning, `dash-u2-${runId}`),
        generationEvent(genB, traceB, day1LateMorning, `dash-model-a-${runId}`, 300, {
          level: "ERROR",
          statusMessage: "boom",
        }),
        traceEvent(traceC, day2Morning, `dash-u1-${runId}`),
        generationEvent(genC, traceC, day2Morning, `dash-model-b-${runId}`, 200),
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: day1Morning,
          body: {
            id: `dash-score-${runId}`,
            traceId: traceA,
            name: `dash-quality-${runId}`,
            value: 0.8,
            dataType: "NUMERIC",
          },
        },
      ],
    });
    expect(res.status).toBe(207);
    expect(res.body.errors).toEqual([]);

    // Materialize the seeded days into daily_stats.
    const { backfillMissingDays } = await import("@peri-fuse/shared/src/server/stats/daily-stats");
    await backfillMissingDays();
    clearResponseCache();
  });

  it("serves all-time summary figures from the rollups", async () => {
    const res = await apiGet("/api/public/dashboard");
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.totalTraces).toBe(3);
    expect(s.totalObservations).toBe(3);
    expect(s.totalGenerations).toBe(3);
    expect(s.totalScores).toBe(1);
    expect(s.totalTokens).toBe(650);
    expect(s.totalUsers).toBe(2);
    expect(s.errorCount).toBe(1);
    expect(s.avgLatencyMs).toBeGreaterThan(0);
    expect(s.p95LatencyMs).toBeGreaterThanOrEqual(s.p50LatencyMs);
  });

  it("returns one daily bucket per seeded day with matching totals", async () => {
    const res = await apiGet("/api/public/dashboard");
    const buckets = res.body.daily.filter((d: { date: string }) =>
      [day1Day, day2Day].includes(d.date),
    );
    expect(buckets).toHaveLength(2);
    const b1 = buckets.find((b: { date: string }) => b.date === day1Day);
    const b2 = buckets.find((b: { date: string }) => b.date === day2Day);
    expect(b1.traces).toBe(2);
    expect(b1.tokens).toBe(450);
    expect(b1.errors).toBe(1);
    expect(b2.traces).toBe(1);
    expect(b2.tokens).toBe(200);
    // Scores carry their ingestion timestamp (legacy behavior), so the score
    // bucket lands on today's date.
    const today = new Date().toISOString().slice(0, 10);
    const scoreBucket = res.body.daily.find((d: { date: string }) => d.date === today);
    expect(scoreBucket?.avgScore).toBeCloseTo(0.8, 5);
  });

  it("breaks down tokens and latency by model", async () => {
    const res = await apiGet("/api/public/dashboard");
    const modelA = res.body.byModel.find(
      (m: { model: string }) => m.model === `dash-model-a-${runId}`,
    );
    const modelB = res.body.byModel.find(
      (m: { model: string }) => m.model === `dash-model-b-${runId}`,
    );
    expect(modelA.observations).toBe(2);
    expect(modelA.tokens).toBe(450);
    expect(modelB.tokens).toBe(200);
  });

  it("reports level mix, top users and recent errors", async () => {
    const res = await apiGet("/api/public/dashboard");
    const errorLevel = res.body.levels.find((l: { level: string }) => l.level === "ERROR");
    expect(errorLevel.count).toBe(1);
    const top = res.body.topUsers.find((u: { userId: string }) => u.userId === `dash-u1-${runId}`);
    expect(top.traces).toBe(2);
    expect(top.tokens).toBe(350);
    expect(res.body.recentErrors.some((e: { id: string }) => e.id === genB)).toBe(true);
  });

  it("honors a window that starts mid-day (edge day computed live)", async () => {
    clearResponseCache();
    // After day1's traces, before day2's — only trace C remains.
    const from = dayIso(3, 12);
    const res = await apiGet(`/api/public/dashboard?from=${encodeURIComponent(from)}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalTraces).toBe(1);
    expect(res.body.summary.totalTokens).toBe(200);
    expect(res.body.summary.totalUsers).toBe(1);
    const days = res.body.daily.map((d: { date: string }) => d.date);
    expect(days).toContain(day2Day);
    expect(days).not.toContain(day1Day);
  });

  it("honors a window cutting through the newest day (leading edge only)", async () => {
    clearResponseCache();
    const from = dayIso(1, 9); // 1h before trace C
    const res = await apiGet(`/api/public/dashboard?from=${encodeURIComponent(from)}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalTraces).toBe(1);
    expect(res.body.summary.totalTokens).toBe(200);
  });

  it("returns an empty window when from is in the future", async () => {
    clearResponseCache();
    const from = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await apiGet(`/api/public/dashboard?from=${encodeURIComponent(from)}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalTraces).toBe(0);
    expect(res.body.daily).toEqual([]);
  });
});
