/**
 * Path resolution for the Peri-Fuse CLI.
 *
 * Locates the monorepo root (by walking up to `pnpm-workspace.yaml`), the
 * server entry point, and the runtime directory used for the PID/state file
 * and server logs. Mirrors the `findProjectRoot` logic in the server's env.ts
 * so data directories resolve identically.
 */
import * as fs from "node:fs";
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

/** Runtime directory: <root>/.peri-fuse */
export function runtimeDir(): string {
  return path.join(findProjectRoot(), ".peri-fuse");
}

/** State file: <root>/.peri-fuse/server.json */
export function stateFile(): string {
  return path.join(runtimeDir(), "server.json");
}

/** Log file: <root>/.peri-fuse/server.log */
export function logFile(): string {
  return path.join(runtimeDir(), "server.log");
}

/** Server entry point: <root>/packages/server/dist/index.js */
export function serverEntry(): string {
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
