/**
 * `peri-fuse stop` — stop the background server.
 */
import { stopServer } from "../lib/daemon";
import { output } from "../lib/output";

export async function stopCommand(): Promise<void> {
  output.info("Stopping server…");
  const { stopped, wasRunning } = await stopServer();

  if (!wasRunning) {
    output.info("Server is not running.");
    return;
  }

  if (stopped) {
    output.success("Server stopped.");
  } else {
    output.warn("Server may not have stopped cleanly.");
  }
}
