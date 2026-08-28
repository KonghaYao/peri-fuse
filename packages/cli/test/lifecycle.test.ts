import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRestartCommand } from "../src/commands/restart";
import { runStartCommand } from "../src/commands/start";
import { runStatusCommand } from "../src/commands/status";
import { checkHealth, cleanupStartedServer, stopServer, waitForHealthy } from "../src/lib/daemon";
import type { RuntimeState } from "../src/lib/paths";

interface CapturedOutput {
  info: string[];
  success: string[];
  warn: string[];
  error: string[];
  dim: string[];
  plain: string[];
}

function captureOutput() {
  const calls: CapturedOutput = {
    info: [],
    success: [],
    warn: [],
    error: [],
    dim: [],
    plain: [],
  };

  return {
    calls,
    output: {
      info: (message: string) => calls.info.push(message),
      success: (message: string) => calls.success.push(message),
      warn: (message: string) => calls.warn.push(message),
      error: (message: string) => calls.error.push(message),
      dim: (message: string) => calls.dim.push(message),
      plain: (message: string) => calls.plain.push(message),
    },
  };
}

const STARTED_STATE: RuntimeState = {
  pid: 4242,
  port: 23332,
  startedAt: 1_700_000_000_000,
  logFile: "/tmp/peri-fuse-test/server.log",
};

describe("CLI lifecycle commands", () => {
  it("fails but preserves the newly started server state when health times out", async () => {
    const { calls, output } = captureOutput();
    const cleanedPids: number[] = [];

    const exitCode = await runStartCommand({
      startServer: () => ({ state: STARTED_STATE, alreadyRunning: false }),
      waitForHealthy: async () => ({ status: "timeout" }),
      cleanupStartedServer: async (state) => {
        cleanedPids.push(state.pid);
      },
      output,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(cleanedPids, []);
    assert.match(calls.error.join("\n"), /health check timed out/i);
    assert.match(calls.dim.join("\n"), /server\.log/);
    assert.equal(calls.success.length, 0);
  });

  it("fails restart but preserves the new server state when health times out", async () => {
    const { calls, output } = captureOutput();
    const cleanedPids: number[] = [];

    const exitCode = await runRestartCommand({
      stopServer: async () => ({ stopped: true, wasRunning: true }),
      startServer: () => ({ state: STARTED_STATE, alreadyRunning: false }),
      waitForHealthy: async () => ({ status: "timeout" }),
      cleanupStartedServer: async (state) => {
        cleanedPids.push(state.pid);
      },
      output,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(cleanedPids, []);
    assert.match(calls.error.join("\n"), /health check timed out/i);
    assert.equal(calls.success.filter((message) => /server is up/i.test(message)).length, 0);
  });

  it("reports a live but unhealthy server as a failing status", async () => {
    const { calls, output } = captureOutput();

    const exitCode = await runStatusCommand({
      readState: () => STARTED_STATE,
      isAlive: () => true,
      clearStateForPid: () => assert.fail("live server state must not be cleared"),
      checkHealth: async () => false,
      now: () => STARTED_STATE.startedAt + 60_000,
      output,
    });

    assert.equal(exitCode, 1);
    assert.match(calls.warn.join("\n"), /process is alive/i);
    assert.equal(calls.success.length, 0);
  });

  it("cleans up a failed start only while the runtime state still owns its pid", async () => {
    const stopCalls: Array<[number, number | undefined]> = [];
    const replacementState = { ...STARTED_STATE, pid: 9999 };

    await cleanupStartedServer(STARTED_STATE, {
      readState: () => replacementState,
      stopServer: async (timeoutMs, expectedPid) => {
        stopCalls.push([timeoutMs, expectedPid]);
        return { stopped: true, wasRunning: true };
      },
    });
    assert.deepEqual(stopCalls, []);

    await cleanupStartedServer(STARTED_STATE, {
      readState: () => STARTED_STATE,
      stopServer: async (timeoutMs, expectedPid) => {
        stopCalls.push([timeoutMs, expectedPid]);
        return { stopped: true, wasRunning: true };
      },
    });
    assert.deepEqual(stopCalls, [[8000, STARTED_STATE.pid]]);
  });

  it("preserves state when SIGTERM and SIGKILL do not stop the recorded process", async () => {
    let now = 0;
    const signals: NodeJS.Signals[] = [];
    const clearedPids: number[] = [];

    const result = await stopServer(400, STARTED_STATE.pid, {
      readState: () => STARTED_STATE,
      isAlive: () => true,
      kill: (_pid, signal) => signals.push(signal),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      clearStateForPid: (pid) => {
        clearedPids.push(pid);
        return true;
      },
    });

    assert.deepEqual(result, { stopped: false, wasRunning: true });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(clearedPids, []);
  });

  it("clears only the recorded pid after SIGKILL is observed to exit", async () => {
    let now = 0;
    let alive = true;
    const clearedPids: number[] = [];

    const result = await stopServer(400, STARTED_STATE.pid, {
      readState: () => STARTED_STATE,
      isAlive: () => alive,
      kill: (_pid, signal) => {
        if (signal === "SIGKILL") alive = false;
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      clearStateForPid: (pid) => {
        clearedPids.push(pid);
        return true;
      },
    });

    assert.deepEqual(result, { stopped: true, wasRunning: true });
    assert.deepEqual(clearedPids, [STARTED_STATE.pid]);
  });

  it("returns truthful start outcomes for healthy, existing, and spawn-error states", async () => {
    const healthyNewOutput = captureOutput();
    assert.equal(
      await runStartCommand({
        startServer: () => ({ state: STARTED_STATE, alreadyRunning: false }),
        waitForHealthy: async () => ({ status: "healthy" }),
        cleanupStartedServer: async () => assert.fail("healthy start must not be cleaned up"),
        output: healthyNewOutput.output,
      }),
      0,
    );
    assert.match(healthyNewOutput.calls.success.join("\n"), /server is up/i);

    const healthyExistingOutput = captureOutput();
    assert.equal(
      await runStartCommand({
        startServer: () => ({ state: STARTED_STATE, alreadyRunning: true }),
        waitForHealthy: async () => ({ status: "healthy" }),
        cleanupStartedServer: async () => assert.fail("existing server must not be cleaned up"),
        output: healthyExistingOutput.output,
      }),
      0,
    );
    assert.match(healthyExistingOutput.calls.info.join("\n"), /already running/i);

    const unhealthyExistingOutput = captureOutput();
    assert.equal(
      await runStartCommand({
        startServer: () => ({ state: STARTED_STATE, alreadyRunning: true }),
        waitForHealthy: async () => ({ status: "exited" }),
        cleanupStartedServer: async () => assert.fail("old server must not be cleaned up"),
        output: unhealthyExistingOutput.output,
      }),
      1,
    );
    assert.match(unhealthyExistingOutput.calls.error.join("\n"), /process exited/i);

    const spawnErrorOutput = captureOutput();
    assert.equal(
      await runStartCommand({
        startServer: () => {
          throw new Error("build missing");
        },
        waitForHealthy: async () => assert.fail("spawn error must not probe health"),
        cleanupStartedServer: async () => assert.fail("spawn error owns no child"),
        output: spawnErrorOutput.output,
      }),
      1,
    );
    assert.match(spawnErrorOutput.calls.error.join("\n"), /build missing/i);
  });

  it("returns truthful restart outcomes for healthy and startup-error states", async () => {
    const healthyOutput = captureOutput();
    assert.equal(
      await runRestartCommand({
        stopServer: async () => ({ stopped: true, wasRunning: true }),
        startServer: () => ({ state: STARTED_STATE, alreadyRunning: false }),
        waitForHealthy: async () => ({ status: "healthy" }),
        cleanupStartedServer: async () => assert.fail("healthy restart must not be cleaned up"),
        output: healthyOutput.output,
      }),
      0,
    );
    assert.match(healthyOutput.calls.success.join("\n"), /server is up/i);

    const startErrorOutput = captureOutput();
    assert.equal(
      await runRestartCommand({
        stopServer: async () => ({ stopped: false, wasRunning: false }),
        startServer: () => {
          throw new Error("cannot spawn");
        },
        waitForHealthy: async () => assert.fail("spawn error must not probe health"),
        cleanupStartedServer: async () => assert.fail("spawn error owns no child"),
        output: startErrorOutput.output,
      }),
      1,
    );
    assert.match(startErrorOutput.calls.error.join("\n"), /cannot spawn/i);
  });

  it("does not spawn a replacement when the old server is still alive", async () => {
    const { calls, output } = captureOutput();
    let spawned = false;

    const exitCode = await runRestartCommand({
      stopServer: async () => ({ stopped: false, wasRunning: true }),
      startServer: () => {
        spawned = true;
        return { state: STARTED_STATE, alreadyRunning: false };
      },
      waitForHealthy: async () => assert.fail("failed stop must not probe a replacement"),
      cleanupStartedServer: async () => assert.fail("failed stop owns no replacement"),
      output,
    });

    assert.equal(exitCode, 1);
    assert.equal(spawned, false);
    assert.match(calls.error.join("\n"), /could not stop|still running/i);
  });

  it("returns truthful status outcomes for missing, stale, and healthy state", async () => {
    const missingOutput = captureOutput();
    assert.equal(
      await runStatusCommand({
        readState: () => null,
        isAlive: () => assert.fail("missing state has no pid"),
        clearStateForPid: () => assert.fail("missing state needs no cleanup"),
        checkHealth: async () => assert.fail("missing state must not probe health"),
        now: Date.now,
        output: missingOutput.output,
      }),
      1,
    );

    const staleCleanupPids: number[] = [];
    const staleOutput = captureOutput();
    assert.equal(
      await runStatusCommand({
        readState: () => STARTED_STATE,
        isAlive: () => false,
        clearStateForPid: (pid) => {
          staleCleanupPids.push(pid);
        },
        checkHealth: async () => assert.fail("stale process must not probe health"),
        now: Date.now,
        output: staleOutput.output,
      }),
      1,
    );
    assert.deepEqual(staleCleanupPids, [STARTED_STATE.pid]);

    const healthyOutput = captureOutput();
    assert.equal(
      await runStatusCommand({
        readState: () => STARTED_STATE,
        isAlive: () => true,
        clearStateForPid: () => assert.fail("healthy state must not be cleared"),
        checkHealth: async () => true,
        now: () => STARTED_STATE.startedAt + 1_000,
        output: healthyOutput.output,
      }),
      0,
    );
    assert.match(healthyOutput.calls.success.join("\n"), /running/i);
  });

  it("classifies health without real network calls, processes, or timers", async () => {
    assert.deepEqual(
      await waitForHealthy(STARTED_STATE, 600, {
        isAlive: () => false,
        checkHealth: async () => assert.fail("dead process must not use the network"),
        now: () => 0,
        sleep: async () => assert.fail("dead process must not sleep"),
      }),
      { status: "exited" },
    );

    assert.deepEqual(
      await waitForHealthy(STARTED_STATE, 600, {
        isAlive: () => true,
        checkHealth: async () => true,
        now: () => 0,
        sleep: async () => assert.fail("healthy process must not sleep"),
      }),
      { status: "healthy" },
    );

    let aliveChecks = 0;
    assert.deepEqual(
      await waitForHealthy(STARTED_STATE, 600, {
        isAlive: () => ++aliveChecks === 1,
        checkHealth: async () => true,
        now: () => 0,
        sleep: async () => assert.fail("a completed probe must not sleep"),
      }),
      { status: "exited" },
    );

    let now = 0;
    const probeBudgets: Array<number | undefined> = [];
    assert.deepEqual(
      await waitForHealthy(STARTED_STATE, 600, {
        isAlive: () => true,
        checkHealth: async (_port, timeoutMs?: number) => {
          probeBudgets.push(timeoutMs);
          now += timeoutMs ?? 600;
          return false;
        },
        now: () => now,
        sleep: async () => assert.fail("a probe consuming the full budget must not sleep"),
      }),
      { status: "timeout" },
    );
    assert.deepEqual(probeBudgets, [600]);
  });

  it("bounds each health fetch with an abort signal", async () => {
    const originalFetch = globalThis.fetch;
    let overrideFetchCalled = false;
    let observedTimeout: number | undefined;
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = async () => new Response(null, { status: 200 });

    try {
      const healthy = await checkHealth(STARTED_STATE.port, 25, {
        fetch: async (_input, init) => {
          overrideFetchCalled = true;
          observedSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            observedSignal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
        setTimeout: (callback, ms) => {
          observedTimeout = ms;
          queueMicrotask(callback);
          return 1 as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {},
      });

      assert.equal(healthy, false);
      assert.equal(overrideFetchCalled, true);
      assert.equal(observedTimeout, 25);
      assert.equal(observedSignal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
