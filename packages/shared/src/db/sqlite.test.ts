import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalDatabase, openLocalDatabase } from "./local";
import { assertSqliteRuntime, createSqliteDatabase } from "./sqlite";

const onBun = typeof process.versions.bun === "string";
const directories: string[] = [];
const REQUIRES_BUN = expect.objectContaining({ code: "PERIFUSE_SQLITE_REQUIRES_BUN" });

function temporaryFile(name = "engine.db"): string {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-sqlite-"));
  directories.push(directory);
  return join(directory, name);
}

function withEngine<T>(engine: string, run: () => T): T {
  const previous = process.env.PERIFUSE_ENGINE;
  process.env.PERIFUSE_ENGINE = engine;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.PERIFUSE_ENGINE;
    else process.env.PERIFUSE_ENGINE = previous;
  }
}

const createSqlite = (filename: string, readonly = false) =>
  withEngine("sqlite", () => createLocalDatabase(filename, readonly));
const openSqlite = (filename: string, readonly = false) =>
  withEngine("sqlite", () => openLocalDatabase(filename, readonly));
const pragma = (row: unknown): number | string =>
  Object.values((row ?? {}) as Record<string, unknown>)[0] as number | string;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("sqlite engine runtime guard", () => {
  it("accepts Bun >= 1.4.0 and rejects every other runtime", () => {
    const versions = process.versions as unknown as NodeJS.ProcessVersions;
    if (onBun) expect(() => assertSqliteRuntime(versions)).not.toThrow();
    else expect(() => assertSqliteRuntime(versions)).toThrow(REQUIRES_BUN);
    expect(() => assertSqliteRuntime({ ...versions, bun: "1.3.9" })).toThrow(REQUIRES_BUN);
    expect(() => assertSqliteRuntime({ ...versions, bun: "1.4" })).not.toThrow();
    expect(() => assertSqliteRuntime({ ...versions, bun: "2.0.0-canary.1" })).not.toThrow();
  });

  it("refuses to open a sqlite database on Node before any file is created", () => {
    const filename = temporaryFile();
    if (onBun) expect(() => createSqliteDatabase(filename)).not.toThrow();
    else {
      expect(() => createSqliteDatabase(filename)).toThrow(REQUIRES_BUN);
      expect(existsSync(filename)).toBe(false);
    }
  });
});

describe.skipIf(!onBun)("sqlite engine connection", () => {
  it("connects lazily, resolves its name and closes idempotently", async () => {
    const filename = temporaryFile();
    const database = createSqlite(filename);
    expect(database.name).toBe(filename);
    expect(existsSync(filename)).toBe(false);
    await database.connect();
    await database.connect();
    await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
    expect(existsSync(filename)).toBe(true);
    await expect(database.run("INSERT INTO items VALUES(1,'a')")).resolves.toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    await database.close();
    await database.close();
    await expect(database.get("SELECT 1 AS value")).rejects.toThrow("Database is closed");
  });

  it("applies the connection pragmas and activates WAL only for writable files", async () => {
    const database = await openSqlite(temporaryFile());
    try {
      expect(pragma(await database.get("PRAGMA busy_timeout"))).toBe(50);
      expect(pragma(await database.get("PRAGMA foreign_keys"))).toBe(1);
      expect(pragma(await database.get("PRAGMA synchronous"))).toBe(2);
      expect(pragma(await database.get("PRAGMA wal_autocheckpoint"))).toBe(1000);
      expect(pragma(await database.get("PRAGMA journal_mode"))).toBe("wal");
    } finally {
      await database.close();
    }
    const memory = await openSqlite(":memory:");
    try {
      expect(pragma(await memory.get("PRAGMA journal_mode"))).toBe("memory");
      expect(pragma(await memory.get("PRAGMA foreign_keys"))).toBe(1);
    } finally {
      await memory.close();
    }
  });

  it("rejects read-only in-memory databases", () => {
    expect(() => createSqlite(":memory:", true)).toThrow(
      expect.objectContaining({ code: "PERIFUSE_SQLITE_READONLY_MEMORY" }),
    );
  });

  it("does not create a missing file read-only and never writes to it", async () => {
    const filename = temporaryFile();
    const missing = join(filename, "..", "absent.db");
    const writable = await openSqlite(filename);
    await writable.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
    await writable.run("INSERT INTO items VALUES(1,'kept')");
    await writable.close();

    const readonly = createSqlite(missing, true);
    await expect(readonly.connect()).rejects.toThrow();
    await readonly.close();
    expect(existsSync(missing)).toBe(false);

    const reader = createSqlite(filename, true);
    const before = readFileSync(filename);
    try {
      expect(await reader.get("SELECT value FROM items WHERE id=1")).toEqual({ value: "kept" });
      expect(await reader.all("SELECT id FROM items")).toEqual([{ id: 1 }]);
      expect(pragma(await reader.get("PRAGMA journal_mode"))).toBe("wal");
      await expect(reader.run("INSERT INTO items VALUES(2,'x')")).rejects.toThrow();
      await expect(reader.exec("CREATE TABLE other(id INTEGER)")).rejects.toThrow();
      await expect(reader.transactionAsync(async () => undefined).immediate()).rejects.toThrow(
        "read-only",
      );
      // A write statement may compile; it must fail when executed.
      const statement = await reader.prepare("INSERT INTO items VALUES(3,'y')");
      await expect(statement.run()).rejects.toThrow();
      statement.close();
    } finally {
      await reader.close();
    }
    expect(readFileSync(filename)).toEqual(before);
  });

  it("reports readers, including INSERT ... RETURNING, and rejects closed statements", async () => {
    const database = await openSqlite(temporaryFile());
    try {
      const select = await database.prepare("SELECT 1 AS value");
      expect(select.reader).toBe(true);
      expect(select.columns()).toEqual([
        { name: "value", type: null, column: null, table: null, database: null },
      ]);
      select.close();
      await expect(select.all()).rejects.toThrow("Statement is closed");

      await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
      const returning = await database.prepare("INSERT INTO items(value) VALUES('x') RETURNING id");
      expect(returning.reader).toBe(true);
      await expect(returning.get()).resolves.toEqual({ id: 1 });
      returning.close();

      const typed = await database.prepare("SELECT id, value FROM items");
      await typed.all();
      expect(typed.columns().map((column) => column.type)).toEqual(["INTEGER", "TEXT"]);
      typed.close();
    } finally {
      await database.close();
    }
  });

  it("fails every operation of a connection whose initialization failed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perifuse-sqlite-"));
    directories.push(directory);
    const database = createSqliteDatabase(join(directory, "absent", "database.db"), true);
    await expect(database.connect()).rejects.toThrow();
    await expect(database.get("SELECT 1 AS value")).rejects.toThrow();
    await database.close();
  });
});
