import { deflateSync, inflateSync } from "node:zlib";
import type Database from "better-sqlite3";

export const IO_MAX_BYTES = 32 * 1024 * 1024;
export const IO_MIN_BYTES = 1024;

/** codec=0 为原 TEXT（历史 raw_size 可为 NULL），codec=1 为 zlib UTF-8 v1。
 * 原列只存一种正文；版本与长度不从正文推断。旧 binary 不可读写 codec=1，
 * off 仅停止新增压缩，不构成降级方案。禁止未经适配的 SQL 单独修改正文列。
 */
export function initializeIoSchema(db: Database.Database): void {
  db.transaction(() => {
    for (const table of ["traces", "observations"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      for (const field of ["input", "output"]) {
        for (const [suffix, ddl] of [
          ["codec", "INTEGER NOT NULL DEFAULT 0"],
          ["raw_size", "INTEGER"],
        ]) {
          const name = `${field}_${suffix}`;
          if (!columns.some((c) => c.name === name)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
          }
        }
      }
    }
  })();
}

/** 主连接与 worker 共用固定源码。调用必须显式提供正文、codec、raw_size。 */
export const IO_READER_SOURCE = `
const ioInflate = require("node:zlib").inflateSync;
const ioSize = (value, codec, size) => {
  if (codec === 0) {
    if (value !== null && typeof value !== "string") throw new Error("IO_COMPRESSION_INVALID");
    const length = value === null ? 0 : Buffer.byteLength(value, "utf8");
    if (size !== null && size !== length) throw new Error("IO_COMPRESSION_LENGTH");
    return length;
  }
  if (codec !== 1) throw new Error("IO_COMPRESSION_VERSION");
  if (!Buffer.isBuffer(value) || !Number.isSafeInteger(size) || size < 0)
    throw new Error("IO_COMPRESSION_INVALID");
  if (size > 32 * 1024 * 1024) throw new Error("IO_COMPRESSION_LIMIT");
  return size;
};
db.function("perifuse_io_bytes", { deterministic: true }, ioSize);
db.function("perifuse_io", { deterministic: true }, (value, codec, size) => {
  const length = ioSize(value, codec, size);
  if (codec === 0) return value;
  try {
    const result = ioInflate(value, { maxOutputLength: Math.max(1, length), info: true });
    const raw = result.buffer;
    if (raw.length !== length || result.engine.bytesWritten !== value.length) throw new Error();
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) throw new Error();
    return text;
  } catch { throw new Error("IO_COMPRESSION_CORRUPT"); }
});
for (const table of ["traces", "observations"]) {
  const columns = db.prepare("PRAGMA table_info(" + table + ")").all();
  if (!columns.some(({ name }) => name === "input_codec")) continue;
  const select = columns.filter(({ name }) => !/^(input|output)_(codec|raw_size)$/.test(name)).map(({ name }) => {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    return name === "input" || name === "output"
      ? "perifuse_io(" + quoted + "," + name + "_codec," + name + "_raw_size) AS " + quoted : quoted;
  }).join(",");
  db.exec("CREATE TEMP VIEW IF NOT EXISTS perifuse_read_" + table + " AS SELECT " + select + " FROM main." + table);
}
`;

export function installIoReader(db: Database.Database): void {
  // 固定源码，无用户输入；只注册函数与 TEMP 视图，不写数据库或迁移只读连接。
  new Function("db", "require", IO_READER_SOURCE)(db, () => ({ inflateSync }));
}

/** 输入必须是原 TEXT，不 parse/normalize JSON；非字符串拒绝，避免隐式有损转换。
 * 小正文、无收益、超上限一律保留 TEXT；UTF-16 孤立代理项无法无损存为 UTF-8，拒绝写入。
 * 缺失字段不生成任何 codec 列；调用方必须把 ioColumns 返回的列作为同一更新单元。
 */
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

/** 正文与 codec/长度必须使用同一个更新/继承条件，不得分别 COALESCE。 */
export function ioColumns(table: string, column: string): string[] {
  return (table === "traces" || table === "observations") &&
    (column === "input" || column === "output")
    ? [column, `${column}_codec`, `${column}_raw_size`]
    : [column];
}
