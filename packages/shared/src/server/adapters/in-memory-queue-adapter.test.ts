import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryQueueAdapter } from "./in-memory-queue-adapter";

const adapters: InMemoryQueueAdapter[] = [];
function adapter(limits: ConstructorParameters<typeof InMemoryQueueAdapter>[0] = {}) {
  const instance = new InMemoryQueueAdapter(limits);
  adapters.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((instance) => instance.close()));
  vi.useRealTimers();
});

describe("bounded in-memory queues", () => {
  it("rejects a whole bulk submission before accepting any jobs when full", async () => {
    const queues = adapter({ maxJobs: 2 });
    const queue = queues.getQueue("test");
    await queue.add("first", {}, { delay: 60_000 });
    await expect(
      queue.addBulk([
        { name: "second", data: {} },
        { name: "third", data: {} },
      ]),
    ).rejects.toThrow("capacity");
    expect(await queue.getWaitingCount()).toBe(1);
    await queue.add("second", {});
    await expect(queue.add("third", {})).rejects.toThrow("capacity");
  });

  it("bounds bytes and distinct queues independently", async () => {
    const queues = adapter({ maxBytes: 500, maxQueues: 1 });
    await expect(queues.getQueue("test").add("large", "x".repeat(1000))).rejects.toThrow(
      "capacity",
    );
    expect(() => queues.getQueue("another")).toThrow("capacity");
  });

  it("deduplicates job IDs and keeps delayed jobs inside admission capacity", async () => {
    const queues = adapter({ maxJobs: 1 });
    const queue = queues.getQueue("test");
    const first = await queue.add("one", { x: 1 }, { jobId: "same", delay: 60_000 });
    expect(await queue.add("two", { x: 2 }, { jobId: "same" })).toEqual(first);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it("tracks retry timers so closing cannot resurrect failed or delayed jobs", async () => {
    vi.useFakeTimers();
    const queues = adapter();
    const queue = queues.getQueue("test");
    const process = vi.fn(async () => {
      throw new Error("retry");
    });
    queues.createWorker("test", process);
    const failed = vi.fn();
    queue.on("failed", failed);
    await queue.add("retry", {}, { attempts: 3, backoff: { type: "fixed", delay: 1000 } });
    await queue.add("delayed", {}, { delay: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await queue.getWaitingCount()).toBe(2);
    await queue.close();
    expect(failed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(process).toHaveBeenCalledTimes(1);
    expect(await queue.getWaitingCount()).toBe(0);
    expect(await queue.getFailedCount()).toBe(0);
    await expect(queue.add("after close", {})).rejects.toThrow("closed");
  });

  it("caps failed history, respects removeOnFail, and continues after a retry", async () => {
    vi.useFakeTimers();
    const queues = adapter({ maxFailed: 2 });
    const queue = queues.getQueue("test");
    const process = vi.fn(async (job: { attemptsMade: number; name: string }) => {
      if (job.name !== "recover" || job.attemptsMade === 0) throw new Error("failure");
    });
    queues.createWorker("test", process);
    const completed = vi.fn();
    queue.on("completed", completed);
    await queue.addBulk(Array.from({ length: 5 }, () => ({ name: "fail", data: {} })));
    await vi.advanceTimersByTimeAsync(0);
    expect(await queue.getFailedCount()).toBe(2);
    await queue.add("recover", {}, { attempts: 2, backoff: { type: "fixed", delay: 20 } });
    await vi.advanceTimersByTimeAsync(30);
    expect(completed).toHaveBeenCalledOnce();
    await queue.add("fail", {}, { removeOnFail: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await queue.getFailedCount()).toBe(2);
    expect(await queue.getActiveCount()).toBe(0);
  });

  it("owns input and public job snapshots, preserving dates and typed arrays", async () => {
    const queues = adapter({ maxBytes: 2000 });
    const queue = queues.getQueue<{ value: string; date: Date; bytes: Uint8Array }>("snapshots");
    const data = { value: "small", date: new Date(1000), bytes: new Uint8Array([1, 2]) };
    const options = { jobId: "stable", backoff: { type: "fixed" as const, delay: 50 } };
    const submitted = await queue.add("event", data, options);
    data.value = "x".repeat(1_000_000);
    data.date.setTime(9999);
    data.bytes[0] = 99;
    options.backoff.delay = 99999;
    submitted.data.value = "x".repeat(1_000_000);
    submitted.data.bytes[0] = 42;
    submitted.opts.backoff!.delay = 99999;
    const again = await queue.add("event", data, { jobId: "stable" });
    expect(again.data).toEqual({
      value: "small",
      date: new Date(1000),
      bytes: new Uint8Array([1, 2]),
    });
    expect(again.opts.backoff?.delay).toBe(50);
    await expect(queue.add("unsupported", { ...data, value: () => {} })).rejects.toThrow();
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it("does not retain processor mutations in retry or failed history", async () => {
    vi.useFakeTimers();
    const queues = adapter({ maxBytes: 1000, maxFailedBytes: 1000 });
    const queue = queues.getQueue<{ value: string; bytes: Buffer }>("snapshots");
    const seen: string[] = [];
    queues.createWorker<{ value: string; bytes: Buffer }>("snapshots", async (job) => {
      seen.push(job.data.value);
      expect(Buffer.isBuffer(job.data.bytes)).toBe(true);
      expect(job.data.bytes[0]).toBe(1);
      job.data.value = "x".repeat(1_000_000);
      job.data.bytes[0] = 99;
      job.opts.backoff!.delay = 999999;
      throw new Error("retry");
    });
    const failed = vi.fn();
    queue.on("failed", failed);
    await queue.add(
      "event",
      { value: "small", bytes: Buffer.from([1]) },
      {
        attempts: 2,
        backoff: { type: "fixed", delay: 10 },
      },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toEqual(["small", "small"]);
    expect(failed.mock.calls[0][0].data.value).toBe("small");
    expect(await queue.getFailedCount()).toBe(1);
  });

  it("worker close waits for active processing and accurately reports paused state", async () => {
    const queues = adapter();
    const queue = queues.getQueue("test");
    let finish!: () => void;
    const worker = queues.createWorker(
      "test",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await queue.add("active", {});
    const close = worker.close();
    expect(worker.isRunning()).toBe(false);
    await queue.add("waiting", {});
    expect(await queue.getWaitingCount()).toBe(1);
    finish();
    await close;
    expect(await queue.getActiveCount()).toBe(0);
    expect(await queue.getWaitingCount()).toBe(1);
  });
});
