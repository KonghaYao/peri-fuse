/**
 * `peri-fuse start` — launch the server as a background daemon.
 */
import {
  cleanupStartedServer,
  type HealthWaitResult,
  startServer,
  waitForHealthy,
} from "../lib/daemon";
import { output } from "../lib/output";
import type { RuntimeState } from "../lib/paths";

interface StartCommandDependencies {
  startServer: typeof startServer;
  waitForHealthy: (state: RuntimeState) => Promise<HealthWaitResult>;
  cleanupStartedServer: (state: RuntimeState) => Promise<void>;
  output: typeof output;
}

const defaultDependencies: StartCommandDependencies = {
  startServer,
  waitForHealthy,
  cleanupStartedServer,
  output,
};

function reportUnhealthy(
  state: RuntimeState,
  result: Exclude<HealthWaitResult["status"], "healthy">,
  commandOutput: typeof output,
): void {
  const reason =
    result === "exited"
      ? "server process exited before becoming healthy"
      : "health check timed out";
  commandOutput.error(`Server failed to start: ${reason} (pid ${state.pid}, port ${state.port}).`);
  commandOutput.dim(`  Check the logs: ${state.logFile}`);
}

export async function runStartCommand(dependencies: StartCommandDependencies): Promise<0 | 1> {
  const { output: commandOutput } = dependencies;
  let result: ReturnType<StartCommandDependencies["startServer"]>;
  try {
    result = dependencies.startServer();
  } catch (err) {
    commandOutput.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { state, alreadyRunning } = result;
  if (!alreadyRunning) {
    commandOutput.info(`Starting server (pid ${state.pid}, port ${state.port})…`);
  }

  const health = await dependencies.waitForHealthy(state);
  if (health.status === "healthy") {
    if (alreadyRunning) {
      commandOutput.info(`Server already running (pid ${state.pid}, port ${state.port}).`);
    } else {
      commandOutput.success(`Server is up at http://localhost:${state.port}`);
      commandOutput.dim(`  logs:  peri-fuse logs -f`);
      commandOutput.dim(`  stop:  peri-fuse stop`);
    }
    return 0;
  }

  reportUnhealthy(state, health.status, commandOutput);
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

export async function startCommand(): Promise<void> {
  process.exitCode = await runStartCommand(defaultDependencies);
}
