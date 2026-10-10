import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SESSION_SEARCH_WORKER_SOURCE } from "./worker-source";

function startWorker(processed: number) {
  const messages: string[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  const enqueueBackfill = vi.fn(async () => 0);
  const processDirty = vi.fn(async () => processed);
  const parentPort = {
    postMessage: (message: { type: string }) => messages.push(message.type),
    on: vi.fn(),
  };
  runInNewContext(SESSION_SEARCH_WORKER_SOURCE, {
    require: (name: string) => {
      if (name === "node:worker_threads")
        return {
          parentPort,
          workerData: {
            connectionPath: "connection",
            indexerPath: "indexer",
            backfillPath: "backfill",
            dbPath: ":memory:",
          },
        };
      if (name === "connection")
        return {
          createLocalDatabase: () => ({ close: async () => {} }),
          initializeLocalDatabase: async () => {},
        };
      if (name === "indexer") return { processDirty };
      if (name === "backfill") return { enqueueBackfill };
      throw new Error(`Unexpected module: ${name}`);
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: vi.fn(),
    process: { exit: vi.fn() },
  });
  return { messages, timers, enqueueBackfill, processDirty };
}

describe("session search worker scheduling", () => {
  it("polls at an idle pace without repeated success messages", async () => {
    const worker = startWorker(0);
    await vi.waitFor(() => expect(worker.timers).toHaveLength(1));
    expect(worker.timers[0].delay).toBe(1000);
    expect(worker.messages).toEqual(["ready", "tick-ok"]);
    worker.timers[0].callback();
    await vi.waitFor(() => expect(worker.timers).toHaveLength(2));
    expect(worker.timers[1].delay).toBe(1000);
    expect(worker.messages).toEqual(["ready", "tick-ok"]);
    expect(worker.processDirty).toHaveBeenCalledTimes(2);
  });

  it("continues quickly while there is indexing work", async () => {
    const worker = startWorker(1);
    await vi.waitFor(() => expect(worker.timers).toHaveLength(1));
    expect(worker.timers[0].delay).toBe(250);
  });
});
