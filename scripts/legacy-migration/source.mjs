import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const normalized = (name) => name.replaceAll("_", "").toLowerCase();
const derived =
  /^(?:sqlite_|search_fts(?:_|$)|trace_counts$|search_trigrams$|_prisma_migrations$|__drizzle_migrations$)/;

export function fingerprint(filename) {
  return JSON.stringify(
    ["", "-wal"].map((suffix) => {
      const path = `${filename}${suffix}`;
      if (!existsSync(path)) return null;
      const info = statSync(path, { bigint: true });
      return [
        suffix,
        info.dev.toString(),
        info.ino.toString(),
        info.size.toString(),
        info.mtimeNs.toString(),
      ];
    }),
  );
}

export function openSource(filename) {
  const path = realpathSync(filename.startsWith("file:") ? filename.slice(5) : filename);
  const identity = fingerprint(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; BEGIN");
    const tables = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")
      .all();
    if (tables.some((table) => table.name === "_perifuse_migrations"))
      throw new Error(
        "Source is already a current Turso database; do not run legacy migration on it",
      );
    return {
      db,
      path,
      identity,
      tables,
      assertUnchanged() {
        if (fingerprint(path) !== identity)
          throw new Error(
            "Source database or WAL changed during migration; keep all writers stopped and use a new destination",
          );
      },
      close() {
        db.exec("ROLLBACK");
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function buildPlans(source, targetTables) {
  const plans = [];
  const skipped = [];
  for (const table of source.tables) {
    if (derived.test(table.name)) {
      skipped.push(table.name);
      continue;
    }
    const target = targetTables.find(
      (candidate) => normalized(candidate.name) === normalized(table.name),
    );
    if (!target)
      throw new Error(
        `Source table ${table.name} has no destination schema; migration refuses to discard business data`,
      );
    if (/WITHOUT\s+ROWID/i.test(table.sql ?? ""))
      throw new Error(
        `Source table ${table.name} has no rowid; this migration requires rowid tables`,
      );
    const sourceColumns = source.db.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
    const columns = target.columns.flatMap((column) => {
      const matches = sourceColumns.filter(
        (candidate) => normalized(candidate.name) === normalized(column.name),
      );
      if (matches.length > 1)
        throw new Error(`Ambiguous column mapping: ${table.name}.${column.name}`);
      return matches.length
        ? [{ ...column, sourceName: matches[0].name, sourceType: matches[0].type }]
        : [];
    });
    const extra = sourceColumns.filter(
      (column) => !columns.some((candidate) => candidate.sourceName === column.name),
    );
    if (extra.length)
      throw new Error(
        `Unmapped source columns in ${table.name}: ${extra.map((column) => column.name).join(", ")}`,
      );
    const count = source.db
      .prepare(`SELECT count(*) AS count FROM ${quote(table.name)}`)
      .get().count;
    const missing = target.columns.filter(
      (column) =>
        column.notnull &&
        column.dflt_value == null &&
        !columns.some((candidate) => candidate.name === column.name),
    );
    if (count && missing.length)
      throw new Error(
        `Missing required source columns in ${table.name}: ${missing.map((column) => column.name).join(", ")}`,
      );
    source.db.prepare(`SELECT rowid FROM ${quote(table.name)} LIMIT 0`);
    plans.push({ sourceName: table.name, name: target.name, columns, count });
  }
  source.assertUnchanged();
  return { plans, skipped };
}

function timestamp(value, label) {
  if (typeof value === "bigint" || typeof value === "number") return Number(value);
  if (/^-?\d+$/.test(value)) return Number(value);
  const text = value.replace(" ", "T");
  const milliseconds = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid legacy datetime in ${label}`);
  return milliseconds;
}

export function convertValue(value, column, table) {
  if (value === null) return value;
  const label = `${table}.${column.name}`;
  if (/DATE|TIME/i.test(column.sourceType)) {
    const milliseconds = timestamp(value, label);
    if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8640000000000000)
      throw new Error(`Invalid legacy datetime in ${label}`);
    return /INT/i.test(column.type) ? BigInt(milliseconds) : new Date(milliseconds).toISOString();
  }
  if (/INT/i.test(column.type)) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
    if (/BOOL/i.test(column.sourceType) && ["true", "false"].includes(value))
      return value === "true" ? 1n : 0n;
    throw new Error(`Invalid integer in ${label}`);
  }
  if (/REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL/i.test(column.type)) {
    const number = Number(value);
    if (!Number.isFinite(number) || value === "") throw new Error(`Invalid number in ${label}`);
    return number;
  }
  if (/TEXT/i.test(column.type) && !(value instanceof Uint8Array)) return String(value);
  return value;
}

export function* sourceRows(source, plan, cursor) {
  const fields = plan.columns
    .map((column) => `${quote(column.sourceName)} AS ${quote(column.name)}`)
    .join(",");
  const statement = source.db.prepare(
    `SELECT rowid AS __import_rowid${fields ? `,${fields}` : ""} FROM ${quote(plan.sourceName)} ${cursor == null ? "" : "WHERE rowid>?"} ORDER BY rowid`,
  );
  statement.setReadBigInts(true);
  const parameters = cursor == null ? [] : [BigInt(cursor)];
  function* boundedReads() {
    const next = source.db.prepare(
      `SELECT rowid AS __import_rowid${fields ? `,${fields}` : ""} FROM ${quote(plan.sourceName)} WHERE rowid>? ORDER BY rowid LIMIT 1`,
    );
    next.setReadBigInts(true);
    for (let row = statement.get(...parameters); row; row = next.get(row.__import_rowid)) yield row;
  }
  const rows =
    typeof statement.iterate === "function" ? statement.iterate(...parameters) : boundedReads();
  for (const row of rows) {
    yield [
      row.__import_rowid,
      ...plan.columns.map((column) => convertValue(row[column.name], column, plan.name)),
    ];
  }
}

export const INITIAL_DIGEST = createHash("sha256")
  .update("peri-fuse-legacy-import-v1")
  .digest("hex");

export function rowBytes(values) {
  return values.reduce(
    (total, value) =>
      total +
      (typeof value === "string"
        ? Buffer.byteLength(value)
        : value instanceof Uint8Array
          ? value.byteLength
          : 8) +
      32,
    0,
  );
}

export function nextDigest(previous, values) {
  const hash = createHash("sha256");
  hash.update(previous);
  for (const value of values) {
    if (value === null) {
      hash.update("null;");
      continue;
    }
    const data = value instanceof Uint8Array ? value : Buffer.from(String(value));
    hash.update(`${value instanceof Uint8Array ? "blob" : typeof value}:${data.byteLength}:`);
    hash.update(data);
    hash.update(";");
  }
  return hash.digest("hex");
}
