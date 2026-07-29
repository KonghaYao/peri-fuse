/**
 * SQL compatibility helpers for PostgreSQL ↔ SQLite (lite mode).
 *
 * These utilities generate database-appropriate SQL fragments so that
 * raw queries can work in both full mode (PostgreSQL) and lite mode (SQLite).
 */

import { Prisma } from "@prisma/client";
import { isLiteMode } from "../adapters";

/**
 * Case-insensitive LIKE operator.
 * - PostgreSQL: uses ILIKE
 * - SQLite: uses LIKE (case-insensitive for ASCII by default)
 *
 * Usage:
 * ```ts
 * Prisma.sql`WHERE name ${ilike()} ${`%${search}%`}`
 * ```
 */
export function ilike(): Prisma.Sql {
  return Prisma.raw(isLiteMode() ? "LIKE" : "ILIKE");
}

/**
 * Returns the appropriate SQL fragment for casting to integer.
 * - PostgreSQL: `::int`
 * - SQLite: no-op (SQLite has dynamic typing, integers are returned as-is)
 *
 * Usage: append after an expression:
 * ```ts
 * Prisma.sql`COUNT(*)${castInt()} as "count"`
 * ```
 */
export function castInt(): Prisma.Sql {
  return Prisma.raw(isLiteMode() ? "" : "::int");
}

/**
 * Returns the appropriate SQL fragment for casting to bigint.
 * - PostgreSQL: `::bigint`
 * - SQLite: no-op
 */
export function castBigInt(): Prisma.Sql {
  return Prisma.raw(isLiteMode() ? "" : "::bigint");
}

/**
 * Returns the appropriate SQL fragment for casting to text.
 * - PostgreSQL: `::text`
 * - SQLite: no-op (SQLite values are already text-compatible)
 */
export function castText(): Prisma.Sql {
  return Prisma.raw(isLiteMode() ? "" : "::text");
}

/**
 * A string literal with optional ::text cast.
 * - PostgreSQL: `'value'::text`
 * - SQLite: `'value'`
 *
 * Useful in UNION queries where PG needs explicit type annotations.
 */
export function textLiteral(value: string): Prisma.Sql {
  return Prisma.raw(isLiteMode() ? `'${value}'` : `'${value}'::text`);
}

/**
 * SPLIT_PART equivalent.
 * - PostgreSQL: SPLIT_PART(string, delimiter, n)
 * - SQLite: uses substr + instr combination (only supports n=1)
 */
export function splitPartFirst(column: string, delimiter: string): Prisma.Sql {
  if (isLiteMode()) {
    return Prisma.raw(
      `CASE WHEN instr(${column}, '${delimiter}') > 0 THEN substr(${column}, 1, instr(${column}, '${delimiter}') - 1) ELSE ${column} END`,
    );
  }
  return Prisma.raw(`SPLIT_PART(${column}, '${delimiter}', 1)`);
}
