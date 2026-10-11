/**
 * Loading and version guard for Bun's built-in `bun:sqlite` driver.
 *
 * The module is only imported when a sqlite connection is actually opened, so
 * every other engine and every Node process never touches it.
 */
import { createDatabaseError } from "./errors";
import type { NativeStatement } from "./sqlite-statement";

export interface NativeDatabase {
  readonly inTransaction: boolean;
  run(sql: string, ...bindings: unknown[]): { changes: number | bigint };
  prepare(sql: string): NativeStatement;
  close(throwOnError?: boolean): void;
}

export interface BunSqliteModule {
  Database: new (
    filename: string,
    options: { readonly?: boolean; create?: boolean; strict?: boolean; safeIntegers?: boolean },
  ) => NativeDatabase;
}

export const MINIMUM_BUN_VERSION: [number, number, number] = [1, 4, 0];
export const BUSY_TIMEOUT_MS = 50;

// Deliberately not a string literal: `bun:sqlite` must stay a real runtime
// import that neither the TypeScript compiler nor esbuild tries to resolve.
const BUN_SQLITE_MODULE = "bun:sqlite";
let bunSqlite: Promise<BunSqliteModule> | undefined;

export async function loadBunSqlite(): Promise<BunSqliteModule> {
  if (!bunSqlite) bunSqlite = import(BUN_SQLITE_MODULE) as Promise<BunSqliteModule>;
  try {
    return await bunSqlite;
  } catch (error) {
    bunSqlite = undefined;
    throw new Error("Failed to load the bun:sqlite module", { cause: error });
  }
}

function versionTuple(version: string | undefined): [number, number, number] | undefined {
  const parts = version?.split(".").map((part) => Number.parseInt(part, 10));
  if (!parts || parts.length < 2 || parts.some((part) => !Number.isInteger(part))) return undefined;
  return [parts[0], parts[1], parts[2] ?? 0];
}

function compareVersions(
  current: [number, number, number],
  minimum: [number, number, number],
): number {
  for (let index = 0; index < 3; index++)
    if (current[index] !== minimum[index]) return current[index] - minimum[index];
  return 0;
}

/** The sqlite engine needs Bun ≥ 1.4.0; anything else is rejected before I/O. */
export function assertSqliteRuntime(versions: NodeJS.ProcessVersions = process.versions): void {
  const current = versionTuple(versions.bun);
  if (current && compareVersions(current, MINIMUM_BUN_VERSION) >= 0) return;
  throw createDatabaseError(
    "PERIFUSE_SQLITE_REQUIRES_BUN",
    "PERIFUSE_ENGINE=sqlite requires Bun >= 1.4.0",
  );
}

/** Reads the single integer of a `PRAGMA`-style statement and finalizes it. */
export function readPragmaNumber(native: NativeDatabase, sql: string): number | undefined {
  const statement = native.prepare(sql);
  try {
    const row = statement.values()[0];
    return row === undefined ? undefined : Number(row[0]);
  } finally {
    statement.finalize();
  }
}
