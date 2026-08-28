/**
 * `peri-fuse status` — show whether the background server is running.
 */
import pc from "picocolors";
import { checkHealth, clearStateForPid, isAlive } from "../lib/daemon";
import { formatUptime, output } from "../lib/output";
import { readState } from "../lib/paths";

interface StatusCommandDependencies {
  readState: typeof readState;
  isAlive: typeof isAlive;
  clearStateForPid: typeof clearStateForPid;
  checkHealth: typeof checkHealth;
  now: () => number;
  output: typeof output;
}

const defaultDependencies: StatusCommandDependencies = {
  readState,
  isAlive,
  clearStateForPid,
  checkHealth,
  now: Date.now,
  output,
};

export async function runStatusCommand(dependencies: StatusCommandDependencies): Promise<0 | 1> {
  const { output: commandOutput } = dependencies;
  const state = dependencies.readState();

  if (!state) {
    commandOutput.info(`Server is ${pc.bold("not running")}.`);
    commandOutput.dim("  Start it with: peri-fuse start");
    return 1;
  }

  if (!dependencies.isAlive(state.pid)) {
    commandOutput.warn(
      `Server is ${pc.bold("not running")} (stale state for pid ${state.pid} removed).`,
    );
    dependencies.clearStateForPid(state.pid);
    return 1;
  }

  const healthy = await dependencies.checkHealth(state.port);
  const uptime = formatUptime(dependencies.now() - state.startedAt);
  if (!healthy) {
    commandOutput.warn(`Server process is alive but its health check is not responding.`);
    commandOutput.plain(`  pid:      ${state.pid}`);
    commandOutput.plain(`  port:     ${state.port}`);
    commandOutput.plain(`  uptime:   ${uptime}`);
    commandOutput.plain(`  health:   ${pc.yellow("unavailable")}`);
    commandOutput.plain(`  log:      ${state.logFile}`);
    return 1;
  }

  commandOutput.success(`Server is ${pc.bold("running")}.`);
  commandOutput.plain(`  pid:      ${state.pid}`);
  commandOutput.plain(`  port:     ${state.port}`);
  commandOutput.plain(`  url:      http://localhost:${state.port}`);
  commandOutput.plain(`  uptime:   ${uptime}`);
  commandOutput.plain(`  health:   ${pc.green("ok")}`);
  commandOutput.plain(`  log:      ${state.logFile}`);
  return 0;
}

export async function statusCommand(): Promise<void> {
  process.exitCode = await runStatusCommand(defaultDependencies);
}
