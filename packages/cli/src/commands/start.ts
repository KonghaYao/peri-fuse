/**
 * `peri-fuse start` — launch the server as a background daemon.
 */
import { startServer, waitForHealthy } from "../lib/daemon";
import { output } from "../lib/output";

export async function startCommand(): Promise<void> {
  let result;
  try {
    result = startServer();
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const { state, alreadyRunning } = result;

  if (alreadyRunning) {
    output.info(`Server already running (pid ${state.pid}, port ${state.port}).`);
    return;
  }

  output.info(`Starting server (pid ${state.pid}, port ${state.port})…`);

  const healthy = await waitForHealthy(state.port);
  if (healthy) {
    output.success(`Server is up at http://localhost:${state.port}`);
    output.dim(`  logs:  peri-fuse logs -f`);
    output.dim(`  stop:  peri-fuse stop`);
  } else {
    output.warn(`Server process started (pid ${state.pid}) but health check did not respond.`);
    output.dim(`  Check the logs: peri-fuse logs -n 50`);
  }
}
