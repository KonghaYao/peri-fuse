import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { quote } from "./source.mjs";

const require = createRequire(new URL("../../packages/shared/package.json", import.meta.url));
const { Database } = require("@tursodatabase/database");

export function readMigrations(directory) {
  const migrations = [];
  const visit = (current, prefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(current, entry.name), `${name}/`);
      else if (entry.name.endsWith(".sql"))
        migrations.push({ name, sql: readFileSync(join(current, entry.name), "utf8") });
    }
  };
  visit(directory);
  if (!migrations.length) throw new Error("No current migrations found");
  return migrations;
}

export const schemaDigest = (migrations) =>
  createHash("sha256").update(JSON.stringify(migrations)).digest("hex");

export async function openTarget(filename) {
  const db = new Database(
    filename,
    filename === ":memory:" ? {} : { experimental: ["multiprocess_wal"], timeout: 5000 },
  );
  await db.connect();
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  await db.exec("PRAGMA foreign_keys=OFF");
  return db;
}

export async function createSchema(db, migrations) {
  for (const migration of migrations) {
    for (const statement of migration.sql.split("--> statement-breakpoint")) {
      if (statement.trim() && !/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))
        await db.exec(statement);
    }
  }
}

export async function describeTables(db) {
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_perifuse_%'",
  );
  for (const table of tables)
    table.columns = await db.all(`PRAGMA table_info(${quote(table.name)})`);
  return tables;
}

export async function getState(db, key) {
  const row = await db.get("SELECT value FROM _perifuse_legacy_import WHERE key=?", key);
  return row ? JSON.parse(row.value) : null;
}

export async function setState(db, key, value) {
  await db.run(
    "INSERT INTO _perifuse_legacy_import(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify(value),
  );
}

export async function initializeTarget(db, migrations, identity, existed) {
  if (existed) {
    const marker = await db.get("SELECT 1 FROM sqlite_master WHERE name='_perifuse_legacy_import'");
    if (!marker || JSON.stringify(await getState(db, "identity")) !== JSON.stringify(identity))
      throw new Error(
        "Destination belongs to a different migration or source changed; use a new destination directory",
      );
    return;
  }
  await db
    .transactionAsync(async (tx) => {
      await createSchema(tx, migrations);
      await tx.exec(
        "CREATE TABLE _perifuse_legacy_import(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
      );
      await setState(tx, "identity", identity);
    })
    .immediate();
}

export function validateExistingTarget(filename, identity) {
  const reader = new DatabaseSync(filename, { readOnly: true });
  try {
    const marker = reader
      .prepare("SELECT 1 FROM sqlite_master WHERE name='_perifuse_legacy_import'")
      .get();
    const saved = marker
      ? reader.prepare("SELECT value FROM _perifuse_legacy_import WHERE key='identity'").get()
      : null;
    if (!saved || JSON.stringify(JSON.parse(saved.value)) !== JSON.stringify(identity))
      throw new Error(
        "Destination belongs to a different migration or source changed; use a new destination directory",
      );
    const complete = reader
      .prepare("SELECT value FROM _perifuse_legacy_import WHERE key='complete'")
      .get();
    return complete ? JSON.parse(complete.value) === true : false;
  } finally {
    reader.close();
  }
}

export async function checkpoint(db) {
  const result = await db.all("PRAGMA wal_checkpoint(TRUNCATE)");
  if (Number(result[0]?.busy ?? 1) !== 0)
    throw new Error(
      "Destination WAL checkpoint is busy; do not start the service during migration",
    );
}

export async function finishSchema(db, migrations) {
  const indexes = migrations.flatMap((migration) =>
    migration.sql
      .split("--> statement-breakpoint")
      .filter((statement) => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)),
  );
  for (const [index, statement] of indexes.entries()) {
    if (await getState(db, `index:${index}`)) continue;
    await db
      .transactionAsync(async (tx) => {
        await tx.exec(statement);
        await setState(tx, `index:${index}`, true);
      })
      .immediate();
    await checkpoint(db);
  }
  await db
    .transactionAsync(async (tx) => {
      await tx.exec(
        "CREATE TABLE IF NOT EXISTS _perifuse_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
      );
      for (const migration of migrations)
        await tx.run(
          "INSERT INTO _perifuse_migrations(name) VALUES(?) ON CONFLICT(name) DO NOTHING",
          migration.name,
        );
    })
    .immediate();
  await checkpoint(db);
}

export async function completeTarget(filename) {
  const reader = new DatabaseSync(filename, { readOnly: true });
  try {
    reader.exec("PRAGMA cache_size=-8192");
    if (reader.prepare("PRAGMA foreign_key_check").get())
      throw new Error(
        "Destination foreign-key validation failed; source data needs repair before migration can be published",
      );
    const result = reader.prepare("PRAGMA quick_check").get();
    if (!result || Object.values(result)[0] !== "ok")
      throw new Error(
        "Destination SQLite integrity check failed; destination will not be published",
      );
  } finally {
    reader.close();
  }
  const db = await openTarget(filename);
  try {
    await setState(db, "complete", true);
    await checkpoint(db);
  } finally {
    await db.close();
  }
}

export function publish(staging, filename, report) {
  if (existsSync(filename)) throw new Error("Destination already exists; refusing to replace it");
  const wal = `${staging}-wal`;
  if (existsSync(wal) && statSync(wal).size > 32)
    throw new Error(
      "Destination still has WAL frames; checkpoint must complete before publication",
    );
  for (const suffix of ["-wal", "-tshm", "-shm"])
    if (existsSync(`${staging}${suffix}`)) unlinkSync(`${staging}${suffix}`);
  const reportFile = `${filename}.migration.json`;
  const temporaryReport = `${reportFile}.tmp`;
  writeFileSync(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  linkSync(staging, filename);
  unlinkSync(staging);
  renameSync(temporaryReport, reportFile);
}
