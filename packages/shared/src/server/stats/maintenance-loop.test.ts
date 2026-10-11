import { afterEach, describe, expect, it, vi } from "vitest";
import { startMaintenanceLoop } from "./maintenance-loop";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe("serial maintenance", () => {
  it("waits for an in-flight pass to settle before shutdown completes", async () => {
    let finish!: () => void;
    let stopped = false;
    const stop = startMaintenanceLoop(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      async () => {},
      10,
      vi.fn(),
    );
    const shutdown = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await shutdown;
    expect(stopped).toBe(true);
  });

  it("waits for startup/backfill and for each refresh before scheduling another pass", async () => {
    vi.useFakeTimers();
    let finishInitial!: () => void;
    let finishRefresh!: () => void;
    const initial = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInitial = resolve;
        }),
    );
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    stops.push(startMaintenanceLoop(initial, refresh, 30, vi.fn()));
    await vi.advanceTimersByTimeAsync(300);
    expect(initial).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    finishInitial();
    await vi.advanceTimersByTimeAsync(30);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).toHaveBeenCalledOnce();
    finishRefresh();
    await vi.advanceTimersByTimeAsync(30);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("aborts an active pass on stop and does not schedule its successor", async () => {
    vi.useFakeTimers();
    let activeSignal!: AbortSignal;
    let finish!: () => void;
    const refresh = vi.fn();
    const stop = startMaintenanceLoop(
      (signal) => {
        activeSignal = signal;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      refresh,
      10,
      vi.fn(),
    );
    stops.push(stop);
    stop();
    expect(activeSignal.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a failed pass and schedules a later retry without overlapping", async () => {
    vi.useFakeTimers();
    const failed = new Error("maintenance failed");
    const onError = vi.fn();
    const refresh = vi.fn(async () => {});
    stops.push(
      startMaintenanceLoop(
        async () => {
          throw failed;
        },
        refresh,
        10,
        onError,
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(failed);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("request 打断等待：不等到下一个 interval 就补跑一轮", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const stop = startMaintenanceLoop(refresh, refresh, 3_600_000, vi.fn());
    stops.push(stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce(); // initial
    stop.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    // 补跑之后仍回到常规 interval，而不是每 tick 都跑。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("pass 进行中的多个 request 合并成结束后的一轮，stop 后请求无效", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startMaintenanceLoop(refresh, refresh, 10, vi.fn());
    stops.push(stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    stop.request();
    stop.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledOnce(); // 进行中的 pass 不允许重叠
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2); // 两次请求合并成一轮
    const stopping = stop();
    finish();
    await stopping;
    stop.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
