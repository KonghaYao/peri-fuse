/**
 * Path resolution for the Peri-Fuse CLI.
 *
 * Locates the monorepo root (by walking up to `pnpm-workspace.yaml`), the
 * server entry point, and the runtime directory used for the PID/state file
 * and server logs. Mirrors the `findProjectRoot` logic in the server's env.ts
 * so data directories resolve identically.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RuntimeState {
  pid: number;
  port: number;
  startedAt: number;
  logFile: string;
}

let cachedRoot: string | null = null;

/** Walk up from the CLI package until we find the monorepo root. */
export function findProjectRoot(): string {
  if (cachedRoot) return cachedRoot;

  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback to cwd if no workspace marker found.
  cachedRoot = process.cwd();
  return cachedRoot;
}

/**
 * Global data/runtime directory. Shared with the server and gateway so the
 * PID/state file, logs, databases and salt all live in one place, independent
 * of the repo location. Override with PERIFUSE_HOME. Defaults to ~/.peri-fuse.
 */
export function runtimeDir(): string {
  return process.env.PERIFUSE_HOME || path.join(os.homedir(), ".peri-fuse");
}

/** State file: ~/.peri-fuse/server.json */
export function stateFile(): string {
  return path.join(runtimeDir(), "server.json");
}

/** Log file: ~/.peri-fuse/server.log */
export function logFile(): string {
  return path.join(runtimeDir(), "server.log");
}

/**
 * Server entry point.
 * - Published package: bundled dist/server.cjs (self-contained).
 * - Monorepo dev: falls back to <root>/packages/server/dist/index.js.
 */
export function serverEntry(): string {
  // __dirname = dist/lib/ (compiled), server.cjs lives in dist/
  const bundled = path.join(__dirname, "..", "server.cjs");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(findProjectRoot(), "packages", "server", "dist", "index.js");
}

/** Path to the project root .env file (may not exist). */
export function envFile(): string {
  return path.join(findProjectRoot(), ".env");
}

export function ensureRuntimeDir(): void {
  const dir = runtimeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readState(): RuntimeState | null {
  const file = stateFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeState;
  } catch {
    return null;
  }
}

export function writeState(state: RuntimeState): void {
  ensureRuntimeDir();
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), "utf8");
}

export function clearState(): void {
  const file = stateFile();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}
