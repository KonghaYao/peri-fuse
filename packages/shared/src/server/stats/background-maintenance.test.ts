import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { query, command, recomputeDay } = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  recomputeDay: vi.fn(async () => {}),
}));
vi.mock("../adapters", () => ({ getTelemetryDB: () => ({ query, command }) }));
vi.mock("./daily-stats", () => ({ recomputeDay }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { backfillMissingDays, startDailyStatsMaintenance } from "./daily-stats-maintenance";
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
  expect(query.mock.calls[1][0].params).toEqual({ projectCursor: "p199", dayCursor: "2026-09-01" });
  expect(recomputeDay).toHaveBeenCalledTimes(201);
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
