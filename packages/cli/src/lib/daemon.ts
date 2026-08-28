/**
 * Daemon management — spawn/stop/inspect the background server process.
 *
 * The server runs as a detached child process so the CLI can exit while the
 * server keeps running. State (pid/port/startedAt/logFile) is persisted to
 * <root>/.peri-fuse/server.json; combined stdout/stderr goes to server.log.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
import {
  clearState,
  ensureRuntimeDir,
  envFile,
  findProjectRoot,
  logFile,
  type RuntimeState,
  readState,
  serverEntry,
  writeState,
} from "./paths";

const DEFAULT_PORT = 23332;
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/** Check whether a process with the given pid is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read state and confirm the recorded process is actually running. */
export function getRunningState(): RuntimeState | null {
  const state = readState();
  if (!state) return null;
  if (!isAlive(state.pid)) return null;
  return state;
}

/** Resolve the port to use, honoring LITE_SERVER_PORT and .env. */
function resolvePort(env: Record<string, string | undefined>): number {
  const raw = env.LITE_SERVER_PORT ?? process.env.LITE_SERVER_PORT;
  const parsed = raw ? parseInt(raw, 10) : DEFAULT_PORT;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

export interface StartResult {
  state: RuntimeState;
  alreadyRunning: boolean;
}

/**
 * Start the server as a detached background process.
 * Returns the runtime state, or indicates it was already running.
 */
export function startServer(): StartResult {
  const existing = getRunningState();
  if (existing) {
    return { state: existing, alreadyRunning: true };
  }

  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Server build not found at ${entry}\n  Run "pnpm build" first to compile the server.`,
    );
  }

  ensureRuntimeDir();

  // Load .env from project root (server does not read it itself).
  const dotenvEnv: Record<string, string> = {};
  const envPath = envFile();
  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    Object.assign(dotenvEnv, parsed);
  }

  const mergedEnv: Record<string, string | undefined> = { ...process.env, ...dotenvEnv };
  const port = resolvePort(mergedEnv);
  const log = logFile();
  const out = fs.openSync(log, "a");

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: findProjectRoot(),
    env: { ...mergedEnv, LITE_SERVER_PORT: String(port) },
  });

  fs.closeSync(out);

  if (child.pid == null) {
    throw new Error("Failed to spawn server process (no pid returned).");
  }

  const state: RuntimeState = {
    pid: child.pid,
    port,
    startedAt: Date.now(),
    logFile: log,
  };
  writeState(state);
  child.unref();

  return { state, alreadyRunning: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StopResult {
  stopped: boolean;
  wasRunning: boolean;
}

interface StopServerDependencies {
  readState: typeof readState;
  isAlive: typeof isAlive;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  clearStateForPid: (pid: number) => boolean;
}

export function clearStateForPid(pid: number): boolean {
  if (readState()?.pid !== pid) return false;
  clearState();
  return true;
}

/**
 * Stop the background server. Sends SIGTERM, waits for exit, escalates to
 * SIGKILL on timeout, then clears the state file.
 */
export async function stopServer(
  timeoutMs = 8000,
  expectedPid?: number,
  overrides: Partial<StopServerDependencies> = {},
): Promise<StopResult> {
  const dependencies: StopServerDependencies = {
    readState,
    isAlive,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    now: Date.now,
    sleep,
    clearStateForPid,
    ...overrides,
  };
  const state = dependencies.readState();
  if (!state) {
    return { stopped: false, wasRunning: false };
  }
  if (expectedPid !== undefined && state.pid !== expectedPid) {
    return { stopped: false, wasRunning: false };
  }

  if (!dependencies.isAlive(state.pid)) {
    // Stale state — clean up.
    dependencies.clearStateForPid(state.pid);
    return { stopped: false, wasRunning: false };
  }

  try {
    dependencies.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (!dependencies.isAlive(state.pid)) {
      dependencies.clearStateForPid(state.pid);
      return { stopped: true, wasRunning: true };
    }
    throw error;
  }

  const deadline = dependencies.now() + timeoutMs;
  while (dependencies.now() < deadline) {
    if (!dependencies.isAlive(state.pid)) {
      dependencies.clearStateForPid(state.pid);
      return { stopped: true, wasRunning: true };
    }
    await dependencies.sleep(Math.min(200, deadline - dependencies.now()));
  }

  // Escalate.
  try {
    dependencies.kill(state.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await dependencies.sleep(300);
  if (dependencies.isAlive(state.pid)) {
    return { stopped: false, wasRunning: true };
  }
  dependencies.clearStateForPid(state.pid);
  return { stopped: true, wasRunning: true };
}

export type HealthWaitResult = { status: "healthy" | "exited" | "timeout" };

interface HealthWaitDependencies {
  isAlive: (pid: number) => boolean;
  checkHealth: (port: number, timeoutMs: number) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Poll the server health endpoint until it responds OK, exits, or times out. */
export async function waitForHealthy(
  state: Pick<RuntimeState, "pid" | "port">,
  timeoutMs = 10000,
  overrides: Partial<HealthWaitDependencies> = {},
): Promise<HealthWaitResult> {
  const dependencies: HealthWaitDependencies = {
    isAlive,
    checkHealth,
    now: Date.now,
    sleep,
    ...overrides,
  };
  const deadline = dependencies.now() + timeoutMs;

  while (dependencies.now() < deadline) {
    if (!dependencies.isAlive(state.pid)) return { status: "exited" };
    const probeTimeoutMs = Math.min(HEALTH_PROBE_TIMEOUT_MS, deadline - dependencies.now());
    const healthy = await dependencies.checkHealth(state.port, probeTimeoutMs);
    if (!dependencies.isAlive(state.pid)) return { status: "exited" };
    if (dependencies.now() >= deadline) return { status: "timeout" };
    if (healthy) return { status: "healthy" };

    const remainingMs = deadline - dependencies.now();
    if (remainingMs > 0) await dependencies.sleep(Math.min(300, remainingMs));
  }

  return dependencies.isAlive(state.pid) ? { status: "timeout" } : { status: "exited" };
}

interface CleanupStartedServerDependencies {
  readState: typeof readState;
  stopServer: typeof stopServer;
}

/** Stop and clear state only when it still belongs to a server started by this command. */
export async function cleanupStartedServer(
  state: RuntimeState,
  dependencies: CleanupStartedServerDependencies = { readState, stopServer },
): Promise<void> {
  if (dependencies.readState()?.pid !== state.pid) return;
  await dependencies.stopServer(8000, state.pid);
}

interface HealthCheckDependencies {
  fetch: typeof fetch;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** One-shot health check (no retry), bounded by an abort signal. */
export async function checkHealth(
  port: number,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
  overrides: Partial<HealthCheckDependencies> = {},
): Promise<boolean> {
  const dependencies: HealthCheckDependencies = {
    fetch,
    setTimeout,
    clearTimeout,
    ...overrides,
  };
  const controller = new AbortController();
  const timer = dependencies.setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await dependencies.fetch(`http://localhost:${port}/api/public/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    dependencies.clearTimeout(timer);
  }
}
