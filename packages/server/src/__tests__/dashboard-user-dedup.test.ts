/**
 * Dashboard user dedup across materialized days and live edge days (§7.1).
 *
 * Seeds trace-only activity on three past days for an isolated project, with
 * one user repeated on every day, then checks that the window summary counts
 * that user exactly once while the per-day buckets stay per-day. The window
 * `from` cuts through the oldest day so the leading edge is computed live and
 * merged with the materialized days behind the shared user set.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { clearResponseCache } from "../response-cache";
import { apiGet, apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

const runId = randomUUID().slice(0, 8);

/** ISO instant `daysAgo` days back at `hour:minute` UTC. */
function dayIso(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

const SHARED = `dedup-shared-${runId}`; // appears on all three days
const EARLY = `dedup-early-${runId}`; // day3 morning, outside the mid-day window
const LATE = `dedup-late-${runId}`; // day3 afternoon, inside the mid-day window
const MID = `dedup-mid-${runId}`; // day2 only
const LAST = `dedup-last-${runId}`; // day1 only

const day3 = dayIso(3, 0).slice(0, 10);
const day2 = dayIso(2, 0).slice(0, 10);
const day1 = dayIso(1, 0).slice(0, 10);

const seeded: Array<{ id: string; at: string; userId: string }> = [
  { id: `dedup-${runId}-1`, at: dayIso(3, 9), userId: EARLY },
  { id: `dedup-${runId}-2`, at: dayIso(3, 14), userId: LATE },
  { id: `dedup-${runId}-3`, at: dayIso(3, 14, 30), userId: SHARED },
  { id: `dedup-${runId}-4`, at: dayIso(2, 8), userId: SHARED },
  { id: `dedup-${runId}-5`, at: dayIso(2, 9), userId: MID },
  { id: `dedup-${runId}-6`, at: dayIso(1, 8), userId: SHARED },
  { id: `dedup-${runId}-7`, at: dayIso(1, 9), userId: LAST },
];

const ALL_USERS = 5; // shared, early, late, mid, last

let auth: string;

beforeAll(async () => {
  const project = await createSecondProject();
  auth = project.auth;

  const res = await apiPost(
    "/api/public/ingestion",
    {
      batch: seeded.map((t) => ({
        id: randomUUID(),
        type: "trace-create",
        timestamp: t.at,
        body: { id: t.id, timestamp: t.at, name: `dedup-${t.id}`, userId: t.userId },
      })),
    },
    {},
    auth,
  );
  expect(res.status).toBe(207);
  expect(res.body.errors).toEqual([]);

  const { backfillMissingDays } = await import("@peri-fuse/shared/src/server/stats/daily-stats");
  await backfillMissingDays();
  clearResponseCache();
});

describe("dashboard user dedup", () => {
  it("counts a user repeated on every materialized day once", async () => {
    const res = await apiGet("/api/public/dashboard", auth);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalTraces).toBe(seeded.length);
    expect(res.body.summary.totalUsers).toBe(ALL_USERS);

    const buckets = res.body.daily.filter((d: { date: string }) =>
      [day3, day2, day1].includes(d.date),
    );
    // Per-day buckets stay per-day: 3 + 2 + 2 traces, the shared user in each.
    expect(buckets.map((b: { date: string }) => b.date)).toEqual([day3, day2, day1]);
    expect(buckets.map((b: { traces: number }) => b.traces)).toEqual([3, 2, 2]);
  });

  it("dedupes across materialized days only", async () => {
    clearResponseCache();
    const from = encodeURIComponent(dayIso(2, 0));
    const to = encodeURIComponent(dayIso(0, 0)); // today 00:00, so day1 is closed
    const res = await apiGet(`/api/public/dashboard?from=${from}&to=${to}`, auth);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalTraces).toBe(4); // 2 on day2 + 2 on day1
    expect(res.body.summary.totalUsers).toBe(3); // shared + mid + last
  });

  it("dedupes a live leading edge day against the materialized days", async () => {
    clearResponseCache();
    const from = encodeURIComponent(dayIso(3, 12)); // cuts through day3
    const res = await apiGet(`/api/public/dashboard?from=${from}`, auth);
    expect(res.status).toBe(200);
    // day3 morning (EARLY) drops out; day3 afternoon comes from the live edge.
    expect(res.body.summary.totalTraces).toBe(6);
    expect(res.body.summary.totalUsers).toBe(4); // late + shared + mid + last

    const bucket = res.body.daily.find((d: { date: string }) => d.date === day3);
    expect(bucket.traces).toBe(2); // only the live afternoon traces
  });

  it("reports no users for an empty window", async () => {
    clearResponseCache();
    const from = encodeURIComponent(dayIso(-1, 0)); // tomorrow
    const res = await apiGet(`/api/public/dashboard?from=${from}`, auth);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalUsers).toBe(0);
    expect(res.body.summary.totalTraces).toBe(0);
    expect(res.body.daily).toEqual([]);
  });
});
