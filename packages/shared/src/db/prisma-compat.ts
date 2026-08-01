/**
 * Drop-in replacement for the parts of the `Prisma` namespace that the codebase
 * relies on, backed by Drizzle's SQL template helpers.
 *
 * Historically these came from `@prisma/client`. Drizzle's `sql` template tag is
 * API-compatible for our usage (nesting, `.raw`, `.join`, empty fragment), so raw
 * SQL builders (filterToPrisma / orderByToPrisma / sqlCompat / search) keep
 * working with only an import change.
 */
import { sql as _sql, type SQL } from "drizzle-orm";

/** A raw SQL fragment, equivalent to the former `Prisma.Sql`. */
export type Sql = SQL;

type _JsonValue =
  | string
  | number
  | boolean
  | null
  | _JsonValue[]
  | { [key: string]: _JsonValue };

/**
 * Error mirroring `Prisma.PrismaClientKnownRequestError` so existing
 * `instanceof … && .code === "P2002"|"P2025"` checks keep working. Repositories
 * throw this for unique-constraint / not-found cases that previously surfaced
 * as Prisma error codes.
 */
export class PrismaClientKnownRequestError extends Error {
  code: string;
  meta?: Record<string, unknown>;
  constructor(message: string, opts: { code: string; meta?: Record<string, unknown> }) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = opts.code;
    this.meta = opts.meta;
  }
}
const _PrismaClientKnownRequestError = PrismaClientKnownRequestError;

/**
 * Map a better-sqlite3 / Drizzle error to a Prisma-style code where possible.
 * SQLite sets `code === "SQLITE_CONSTRAINT_UNIQUE"` (or a message containing
 * "UNIQUE constraint failed") for unique violations.
 */
export function toKnownRequestError(err: unknown): PrismaClientKnownRequestError | null {
  const e = err as { code?: string; message?: string };
  const msg = e?.message ?? "";
  if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(msg)) {
    return new PrismaClientKnownRequestError(msg || "Unique constraint failed", {
      code: "P2002",
    });
  }
  return null;
}

// Loose structural stand-ins for Prisma's generated input/where types. Callers
// already build these with `as unknown as …` casts, so a permissive shape is
// sufficient and avoids re-creating Prisma's full conditional type machinery.
export const DbNull = null;

/**
 * The `Prisma` namespace. Declared as a TS namespace so it carries both values
 * (`Prisma.sql`, `Prisma.raw`, `Prisma.PrismaClientKnownRequestError`, …) and
 * types (`Prisma.Sql`, `Prisma.JsonValue`, `Prisma.CommentWhereInput`, …) under
 * a single name — mirroring the original `@prisma/client` export shape.
 */
export namespace Prisma {
  /** Tagged-template SQL builder (drizzle `sql`). */
  export const sql = _sql;
  /** Embed a raw, unescaped SQL string. */
  export const raw = _sql.raw;
  /** Join SQL fragments with a separator. */
  export const join = _sql.join;
  /** An empty SQL fragment (drizzle's `sql.empty()` is a factory, so call it). */
  export const empty = _sql.empty();
  export const PrismaClientKnownRequestError = _PrismaClientKnownRequestError;
  export const DbNull = null;

  export type Sql = SQL;
  export type JsonValue = _JsonValue;
  export type JsonObject = { [key: string]: JsonValue };
  export type CommentWhereInput = Record<string, unknown>;
  export type DatasetWhereInput = Record<string, unknown> & { name?: unknown };
  export type DashboardWhereInput = Record<string, unknown> & { definition?: unknown };
  export type DashboardUncheckedUpdateInput = Record<string, unknown>;
  export type AutomationExecutionWhereInput = Record<string, unknown>;
  export type TransactionClient = unknown;
  export type PrismaClientOptions = Record<string, unknown>;
}
