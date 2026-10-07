import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLocalMigrations,
  createLocalDatabase,
  LOCAL_DATABASE_OPTIONS,
  openLocalDatabase,
  resolveLocalPath,
} from "./local";

const directories: string[] = [];
const temporaryPath = () => {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-local-driver-"));
  directories.push(directory);
  return join(directory, "database.turso.db");
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("embedded Turso local driver", () => {
  it("rejects remote URLs and preserves memory paths", () => {
    expect(resolveLocalPath(":memory:")).toBe(":memory:");
    expect(() => resolveLocalPath("https://example.com/database")).toThrow("Only local");
    expect(() => resolveLocalPath("libsql://example.com")).toThrow("Only local");
  });

  it("rolls back failed migrations and reapplies only missing migrations after reopening", async () => {
    const filename = temporaryPath();
    let db = createLocalDatabase(filename);
    const baseline = {
      name: "001/migration.sql",
      sql: "CREATE TABLE items(id TEXT PRIMARY KEY, value TEXT)",
    };
    try {
      await applyLocalMigrations(db, [baseline]);
      await expect(
        applyLocalMigrations(db, [
          baseline,
          {
            name: "002/migration.sql",
            sql: "INSERT INTO items VALUES('failed','value'); --> statement-breakpoint\nINSERT INTO missing VALUES(1)",
          },
        ]),
      ).rejects.toThrow();
      expect(await db.get("SELECT count(*) AS count FROM items")).toEqual({ count: 0 });
      expect(await db.get("SELECT count(*) AS count FROM _perifuse_migrations")).toEqual({
        count: 1,
      });
    } finally {
      await db.close();
    }
    db = createLocalDatabase(filename);
    try {
      await applyLocalMigrations(db, [
        baseline,
        { name: "002/migration.sql", sql: "INSERT INTO items VALUES('committed','value')" },
      ]);
      expect(await db.get("SELECT id FROM items")).toEqual({ id: "committed" });
      expect(await db.get("SELECT count(*) AS count FROM _perifuse_migrations")).toEqual({
        count: 2,
      });
    } finally {
      await db.close();
    }
  });

  it("does not modify an existing legacy database", async () => {
    const filename = temporaryPath();
    const original = await openLocalDatabase(filename);
    await original.exec(
      "CREATE TABLE legacy(id INTEGER PRIMARY KEY); INSERT INTO legacy VALUES(1)",
    );
    await original.close();
    const before = readFileSync(filename);
    const db = createLocalDatabase(filename);
    try {
      await expect(
        applyLocalMigrations(db, [{ name: "baseline", sql: "CREATE TABLE fresh(id INTEGER)" }]),
      ).rejects.toThrow("legacy database");
    } finally {
      await db.close();
    }
    expect(readFileSync(filename)).toEqual(before);
  });

  it("awaits Drizzle transactions and rolls back a nested savepoint without losing the outer write", async () => {
    const client = await openLocalDatabase(":memory:");
    const items = sqliteTable("items", {
      id: integer().primaryKey(),
      payload: blob({ mode: "buffer" }),
      json: text(),
    });
    const db = drizzle({ client });
    try {
      await client.exec(
        "CREATE TABLE items(id INTEGER PRIMARY KEY, payload BLOB, json TEXT); CREATE TABLE references_table(id INTEGER REFERENCES items(id))",
      );
      await db.transaction(
        async (tx) => {
          await tx.insert(items).values({
            id: 1,
            payload: Buffer.from([0, 255]),
            json: JSON.stringify({ valid: true }),
          });
          await expect(
            tx.transaction(async (nested) => {
              await nested.insert(items).values({ id: 2 });
              throw new Error("savepoint failure");
            }),
          ).rejects.toThrow("savepoint failure");
        },
        { behavior: "immediate" },
      );
      const rows = await db.select().from(items);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual(Buffer.from([0, 255]));
      expect(await client.get("SELECT json_extract(json,'$.valid') AS valid FROM items")).toEqual({
        valid: 1,
      });
      await expect(client.run("INSERT INTO references_table VALUES(2)")).rejects.toThrow(
        "FOREIGN KEY",
      );
    } finally {
      await client.close();
    }
  });

  it("opens a worker with the same WAL options and sees committed writes", async () => {
    const filename = temporaryPath();
    const db = await openLocalDatabase(filename);
    const moduleUrl = pathToFileURL(require.resolve("@tursodatabase/database")).href;
    let worker: Worker | undefined;
    try {
      await db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
      worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { Database } = await import(workerData.moduleUrl);
          const db = new Database(workerData.filename, workerData.options);
          try {
            await db.connect();
            await db.run('INSERT INTO items VALUES(1)');
            parentPort.postMessage(await db.get('SELECT count(*) AS count FROM items'));
          } finally { await db.close(); }
        })().catch(error => { throw error; });
      `,
        { eval: true, workerData: { filename, moduleUrl, options: LOCAL_DATABASE_OPTIONS } },
      );
      const result = await new Promise((resolve, reject) => {
        worker!.once("message", resolve);
        worker!.once("error", reject);
        worker!.once("exit", (code) => {
          if (code) reject(new Error(`Worker exited with ${code}`));
        });
      });
      expect(result).toEqual({ count: 1 });
      expect(await db.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
    } finally {
      await worker?.terminate();
      await db.close();
    }
  });
});
