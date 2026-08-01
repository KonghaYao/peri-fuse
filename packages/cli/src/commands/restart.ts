/**
 * `peri-fuse restart` — stop then start the background server.
 */
import { startServer, stopServer, waitForHealthy } from "../lib/daemon";
import { output } from "../lib/output";

export async function restartCommand(): Promise<void> {
  const { wasRunning } = await stopServer();
  if (wasRunning) {
    output.success("Server stopped.");
  }

  let result;
  try {
    result = startServer();
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const { state } = result;
  output.info(`Starting server (pid ${state.pid}, port ${state.port})…`);

  const healthy = await waitForHealthy(state.port);
  if (healthy) {
    output.success(`Server is up at http://localhost:${state.port}`);
  } else {
    output.warn(`Server process started (pid ${state.pid}) but health check did not respond.`);
    output.dim(`  Check the logs: peri-fuse logs -n 50`);
  }
}
