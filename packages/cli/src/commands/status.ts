/**
 * `peri-fuse status` — show whether the background server is running.
 */
import pc from "picocolors";
import { checkHealth, isAlive } from "../lib/daemon";
import { formatUptime, output } from "../lib/output";
import { clearState, readState } from "../lib/paths";

export async function statusCommand(): Promise<void> {
  const state = readState();

  if (!state) {
    output.info(`Server is ${pc.bold("not running")}.`);
    output.dim("  Start it with: peri-fuse start");
    return;
  }

  if (!isAlive(state.pid)) {
    output.warn(`Server is ${pc.bold("not running")} (stale state for pid ${state.pid} removed).`);
    clearState();
    return;
  }

  const healthy = await checkHealth(state.port);
  const uptime = formatUptime(Date.now() - state.startedAt);

  output.success(`Server is ${pc.bold("running")}.`);
  output.plain(`  pid:      ${state.pid}`);
  output.plain(`  port:     ${state.port}`);
  output.plain(`  url:      http://localhost:${state.port}`);
  output.plain(`  uptime:   ${uptime}`);
  output.plain(`  health:   ${healthy ? pc.green("ok") : pc.yellow("not responding")}`);
  output.plain(`  log:      ${state.logFile}`);
}
