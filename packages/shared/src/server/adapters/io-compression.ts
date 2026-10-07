import { deflateSync, inflateSync } from "node:zlib";
import type { LocalExecutor } from "../../db/local";

export const IO_MAX_BYTES = 32 * 1024 * 1024;
export const IO_MIN_BYTES = 1024;

function makeIoDecoder(inflate: typeof inflateSync) {
  return (source: Record<string, unknown>): Record<string, unknown> => {
    const row = { ...source };
    for (const field of ["input", "output"]) {
      const codec = row[`${field}_codec`];
      const size = row[`${field}_raw_size`];
      if (!(field in row) || codec === undefined) continue;
      const value = row[field];
      if (codec === 0) {
        if (value !== null && typeof value !== "string") throw new Error("IO_COMPRESSION_INVALID");
        const length = value === null ? 0 : Buffer.byteLength(value as string, "utf8");
        if (size != null && size !== length) throw new Error("IO_COMPRESSION_LENGTH");
      } else {
        if (codec !== 1) throw new Error("IO_COMPRESSION_VERSION");
        if (!(value instanceof Uint8Array) || !Number.isSafeInteger(size) || Number(size) < 0)
          throw new Error("IO_COMPRESSION_INVALID");
        if (Number(size) > 32 * 1024 * 1024) throw new Error("IO_COMPRESSION_LIMIT");
        try {
          const result = inflate(value, {
            maxOutputLength: Math.max(1, Number(size)),
            info: true,
          }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
          if (result.buffer.length !== size || result.engine.bytesWritten !== value.byteLength)
            throw new Error();
          const text = result.buffer.toString("utf8");
          if (!Buffer.from(text, "utf8").equals(result.buffer)) throw new Error();
          row[field] = text;
        } catch {
          throw new Error("IO_COMPRESSION_CORRUPT");
        }
      }
      delete row[`${field}_codec`];
      delete row[`${field}_raw_size`];
    }
    return row;
  };
}

export const decodeIoRow = makeIoDecoder(inflateSync);
export const IO_READER_SOURCE = `const decodeIoRow = (${makeIoDecoder.toString()})(require("node:zlib").inflateSync);`;

export async function initializeIoSchema(db: LocalExecutor): Promise<void> {
  for (const table of ["traces", "observations"]) {
    const columns = (await db.all(`PRAGMA table_info(${table})`)) as { name: string }[];
    for (const field of ["input", "output"]) {
      for (const [suffix, ddl] of [
        ["codec", "INTEGER NOT NULL DEFAULT 0"],
        ["raw_size", "INTEGER"],
      ]) {
        const name = `${field}_${suffix}`;
        if (!columns.some((column) => column.name === name))
          await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      }
    }
  }
}

export function encodeIoRow(
  table: string,
  source: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  if (table !== "traces" && table !== "observations") return source;
  const row = { ...source };
  for (const field of ["input", "output"]) {
    if (!(field in row)) continue;
    const value = row[field];
    row[`${field}_codec`] = 0;
    row[`${field}_raw_size`] = 0;
    if (value === null) continue;
    if (typeof value !== "string") throw new Error("IO_TEXT_REQUIRED");
    const size = Buffer.byteLength(value, "utf8");
    row[`${field}_raw_size`] = size;
    if (/[\uD800-\uDFFF]/u.test(value)) throw new Error("IO_TEXT_INVALID_UTF16");
    if (!enabled || size < IO_MIN_BYTES || size > IO_MAX_BYTES) continue;
    const compressed = deflateSync(Buffer.from(value, "utf8"));
    if (compressed.length + 16 >= size) continue;
    row[field] = compressed;
    row[`${field}_codec`] = 1;
  }
  return row;
}

export function ioColumns(table: string, column: string): string[] {
  return (table === "traces" || table === "observations") &&
    (column === "input" || column === "output")
    ? [column, `${column}_codec`, `${column}_raw_size`]
    : [column];
}
