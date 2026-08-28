/**
 * `peri-fuse restart` — stop then start the background server.
 */
import {
  cleanupStartedServer,
  type HealthWaitResult,
  startServer,
  stopServer,
  waitForHealthy,
} from "../lib/daemon";
import { output } from "../lib/output";
import type { RuntimeState } from "../lib/paths";

interface RestartCommandDependencies {
  stopServer: typeof stopServer;
  startServer: typeof startServer;
  waitForHealthy: (state: RuntimeState) => Promise<HealthWaitResult>;
  cleanupStartedServer: (state: RuntimeState) => Promise<void>;
  output: typeof output;
}

const defaultDependencies: RestartCommandDependencies = {
  stopServer,
  startServer,
  waitForHealthy,
  cleanupStartedServer,
  output,
};

export async function runRestartCommand(dependencies: RestartCommandDependencies): Promise<0 | 1> {
  const { output: commandOutput } = dependencies;
  let stopResult: Awaited<ReturnType<RestartCommandDependencies["stopServer"]>>;
  try {
    stopResult = await dependencies.stopServer();
  } catch (err) {
    commandOutput.error(
      `Failed to stop server: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (stopResult.wasRunning && !stopResult.stopped) {
    commandOutput.error(
      "Could not stop the existing server; restart aborted while it is still running.",
    );
    return 1;
  }
  if (stopResult.stopped) commandOutput.success("Server stopped.");

  let startResult: ReturnType<RestartCommandDependencies["startServer"]>;
  try {
    startResult = dependencies.startServer();
  } catch (err) {
    commandOutput.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { state, alreadyRunning } = startResult;
  commandOutput.info(`Starting server (pid ${state.pid}, port ${state.port})…`);
  const health = await dependencies.waitForHealthy(state);
  if (health.status === "healthy") {
    commandOutput.success(`Server is up at http://localhost:${state.port}`);
    return 0;
  }

  const reason =
    health.status === "exited"
      ? "server process exited before becoming healthy"
      : "health check timed out";
  commandOutput.error(
    `Server failed to restart: ${reason} (pid ${state.pid}, port ${state.port}).`,
  );
  commandOutput.dim(`  Check the logs: ${state.logFile}`);

  if (!alreadyRunning && health.status === "exited") {
    try {
      await dependencies.cleanupStartedServer(state);
    } catch (err) {
      commandOutput.warn(
        `Could not clean up failed server pid ${state.pid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return 1;
}

export async function restartCommand(): Promise<void> {
  process.exitCode = await runRestartCommand(defaultDependencies);
}
