import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";
import {
  currentTelemetryQuerySignal,
  recordTelemetryQueryError,
  TelemetryQueryError,
  withTelemetryQuerySignal,
} from "./telemetry-query-context";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("Telemetry request resource errors", () => {
  it("propagates a swallowed resource rejection after the handler returns", async () => {
    const failure = new TelemetryQueryError("RESULT_LIMIT", "paginate the query");
    const request = withTelemetryQuerySignal(new AbortController().signal, async () => {
      try {
        // Simulates a worker-created error surfaced through the adapter's await.
        await Promise.reject(failure);
      } catch (error) {
        recordTelemetryQueryError(error);
      }
      return [];
    });
    await expect(request).rejects.toBe(failure);
    expect(currentTelemetryQuerySignal()).toBeUndefined();
  });

  it("preserves synchronous callers and leaves handled ordinary errors alone", () => {
    const signal = new AbortController().signal;
    expect(
      withTelemetryQuerySignal(signal, () => {
        expect(currentTelemetryQuerySignal()).toBe(signal);
        recordTelemetryQueryError(new Error("a handled query bug"));
        return 42;
      }),
    ).toBe(42);
    const failure = new TelemetryQueryError("OVERLOADED", "queue full");
    expect(() =>
      withTelemetryQuerySignal(signal, () => {
        recordTelemetryQueryError(failure);
        return [];
      }),
    ).toThrow(failure);
  });

  it("isolates concurrent requests and preserves the first resource failure", async () => {
    let resume: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const firstSignal = new AbortController().signal;
    const otherSignal = new AbortController().signal;
    const failure = new TelemetryQueryError("OVERLOADED", "queue full");
    const first = withTelemetryQuerySignal(firstSignal, async () => {
      await gate;
      expect(currentTelemetryQuerySignal()).toBe(firstSignal);
      recordTelemetryQueryError(failure);
      recordTelemetryQueryError(new TelemetryQueryError("TIMEOUT", "second failure"));
      return [];
    });
    const other = withTelemetryQuerySignal(otherSignal, async () => {
      resume();
      await Promise.resolve();
      expect(currentTelemetryQuerySignal()).toBe(otherSignal);
      return [1];
    });
    await expect(first).rejects.toBe(failure);
    await expect(other).resolves.toEqual([1]);
  });

  it("isolates nested scopes, including errors constructed for another request", async () => {
    const outer = new AbortController().signal;
    const result = withTelemetryQuerySignal(outer, async () => {
      // Construction can happen in a worker callback with an unrelated ALS scope.
      const failure = new TelemetryQueryError("UNAVAILABLE", "worker exited");
      await expect(
        withTelemetryQuerySignal(new AbortController().signal, async () => {
          recordTelemetryQueryError(failure);
          return [];
        }),
      ).rejects.toBe(failure);
      expect(currentTelemetryQuerySignal()).toBe(outer);
      return [1];
    });
    await expect(result).resolves.toEqual([1]);
  });

  it("clears completed scopes even when a background callback retains the async context", async () => {
    let resume: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let background: Promise<void> | undefined;
    await withTelemetryQuerySignal(new AbortController().signal, async () => {
      background = gate.then(() => {
        expect(currentTelemetryQuerySignal()).toBeUndefined();
        recordTelemetryQueryError(new TelemetryQueryError("TIMEOUT", "late error"));
      });
    });
    resume();
    await background;
    expect(await withTelemetryQuerySignal(new AbortController().signal, async () => 1)).toBe(1);
  });

  it.each(["0", "1"])(
    "preserves real adapter resource errors swallowed by a repository (%s workers)",
    async (workers) => {
      vi.stubEnv("PERIFUSE_READ_WORKERS", workers);
      const directory = mkdtempSync(join(tmpdir(), "perifuse-query-context-"));
      const adapter = new SQLiteTelemetryAdapter(join(directory, "telemetry.db"));
      try {
        // Start workers outside the failing request, as in a long-running server.
        await adapter.query({ query: "SELECT 1" });
        const request = withTelemetryQuerySignal(new AbortController().signal, async () => {
          try {
            return await adapter.query({ query: "SELECT 1 UNION ALL SELECT 2", maxResultRows: 1 });
          } catch {
            return [];
          }
        });
        await expect(request).rejects.toMatchObject({ code: "RESULT_LIMIT" });
        await expect(
          withTelemetryQuerySignal(new AbortController().signal, () =>
            adapter.query({ query: "SELECT 3 AS n" }),
          ),
        ).resolves.toEqual([{ n: 3 }]);
      } finally {
        await adapter.close();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
