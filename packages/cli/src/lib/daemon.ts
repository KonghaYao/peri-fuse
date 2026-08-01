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
  type RuntimeState,
  clearState,
  ensureRuntimeDir,
  envFile,
  findProjectRoot,
  logFile,
  readState,
  serverEntry,
  writeState,
} from "./paths";

const DEFAULT_PORT = 23332;

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

/**
 * Stop the background server. Sends SIGTERM, waits for exit, escalates to
 * SIGKILL on timeout, then clears the state file.
 */
export async function stopServer(timeoutMs = 8000): Promise<StopResult> {
  const state = readState();
  if (!state) {
    return { stopped: false, wasRunning: false };
  }

  if (!isAlive(state.pid)) {
    // Stale state — clean up.
    clearState();
    return { stopped: false, wasRunning: false };
  }

  process.kill(state.pid, "SIGTERM");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) {
      clearState();
      return { stopped: true, wasRunning: true };
    }
    await sleep(200);
  }

  // Escalate.
  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await sleep(300);
  clearState();
  return { stopped: true, wasRunning: true };
}

/** Poll the server health endpoint until it responds OK or times out. */
export async function waitForHealthy(port: number, timeoutMs = 10000): Promise<boolean> {
  const url = `http://localhost:${port}/api/public/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

/** One-shot health check (no retry). */
export async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/public/health`);
    return res.ok;
  } catch {
    return false;
  }
}
