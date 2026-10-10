import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { query, command, recomputeDay } = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  recomputeDay: vi.fn(async () => {}),
}));
vi.mock("../adapters", () => ({ getTelemetryDB: () => ({ query, command }) }));
vi.mock("./daily-stats", () => ({ recomputeDay }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { repairDirtyDays } from "./daily-stats-dirty";
import {
  backfillMissingDays,
  refreshRecentDays,
  startDailyStatsMaintenance,
} from "./daily-stats-maintenance";
import { startRetentionJob } from "./retention";

const stops: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  query.mockReset().mockResolvedValue([]);
  command.mockReset().mockResolvedValue({ changes: 0 });
  recomputeDay.mockClear();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("daily refresh waits for initial backfill and never overlaps a slow refresh", async () => {
  let finish!: (rows: unknown[]) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startDailyStatsMaintenance(10);
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(100);
  expect(query).toHaveBeenCalledOnce();
  finish([]);
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(query).toHaveBeenCalledTimes(2);
  stop();
  expect(query.mock.calls[1][0].signal.aborted).toBe(true);
  finish([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(query).toHaveBeenCalledTimes(2);
});

it("backfill holds a page of missing days and advances its cursor across pages", async () => {
  const days = Array.from({ length: 200 }, (_, i) => ({ project_id: `p${i}`, day: "2026-09-01" }));
  query.mockResolvedValueOnce(days).mockResolvedValueOnce([{ project_id: "z", day: "2026-09-02" }]);
  const completion = backfillMissingDays();
  await vi.runAllTimersAsync();
  expect(await completion).toBe(201);
  expect(query.mock.calls[1][0].params).toEqual({
    projectCursor: "p199",
    dayCursor: "2026-09-01",
    limit: 200,
  });
  expect(recomputeDay).toHaveBeenCalledTimes(201);
});

it("repairs only dirty project days, including late historical writes", async () => {
  query.mockResolvedValueOnce([
    { project_id: "p", day: "2020-01-01" },
    { project_id: "q", day: "2026-10-10" },
  ]);
  const pass = refreshRecentDays();
  await vi.runAllTimersAsync();
  await pass;
  expect(recomputeDay.mock.calls).toEqual([
    ["p", "2020-01-01"],
    ["q", "2026-10-10"],
  ]);
  expect(query.mock.calls[0][0].query).toContain("FROM daily_stats_dirty");
  expect(query.mock.calls[0][0].query).not.toContain("FROM traces");
  await refreshRecentDays();
  expect(recomputeDay).toHaveBeenCalledTimes(2);
});

it("a continuously changed dirty day receives one on-demand repair attempt", async () => {
  query.mockImplementation(({ query: sql }: { query: string }) =>
    Promise.resolve(sql.startsWith("SELECT dirty") ? [{ dirty: 1 }] : [{ day: "2026-10-10" }]),
  );
  await repairDirtyDays("p", recomputeDay, "2026-10-01", "2026-10-31");
  await repairDirtyDays("p", recomputeDay, "2026-10-01", "2026-10-31");
  expect(query).toHaveBeenCalledTimes(3);
  expect(recomputeDay).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_001);
  await repairDirtyDays("p", recomputeDay, "2026-10-01", "2026-10-31");
  expect(recomputeDay).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(5);
  expect(query.mock.calls[0][0].params).toEqual({
    projectId: "p",
    fromDay: "2026-10-01",
    toDay: "2026-10-31",
  });
  expect(recomputeDay).toHaveBeenLastCalledWith("p", "2026-10-10");
});

it("limits startup backfill to one bounded page", async () => {
  const cursor = { projectId: null as string | null, day: "" };
  query.mockResolvedValueOnce(
    Array.from({ length: 10 }, (_, i) => ({
      project_id: "p",
      day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    })),
  );
  const page = backfillMissingDays(undefined, 10, cursor);
  await vi.runAllTimersAsync();
  expect(await page).toBe(10);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0][0].params.limit).toBe(10);
  expect(cursor).toEqual({ projectId: "p", day: "2026-09-10" });
});

it("retention does not overlap slow passes and stop prevents further delete chunks", async () => {
  vi.stubEnv("PERIFUSE_TELEMETRY_RETENTION_DAYS", "30");
  let finish!: (value: { changes: number }) => void;
  command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startRetentionJob(10);
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(100);
  expect(command).toHaveBeenCalledOnce();
  stop();
  finish({ changes: 50_000 });
  await vi.advanceTimersByTimeAsync(100);
  expect(command).toHaveBeenCalledOnce();
});
