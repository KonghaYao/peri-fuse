import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalDatabase, type LocalDatabase, openLocalDatabase } from "./local";

const onBun = typeof process.versions.bun === "string";
const directories: string[] = [];

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

function temporaryFile(name = "values.db"): string {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-sqlite-values-"));
  directories.push(directory);
  return join(directory, name);
}

async function pair(run: (turso: LocalDatabase, sqlite: LocalDatabase) => Promise<void>) {
  const turso = await withEngine("turso", () => openLocalDatabase(":memory:"));
  const sqlite = await withEngine("sqlite", () => openLocalDatabase(":memory:"));
  try {
    await run(turso, sqlite);
  } finally {
    await turso.close();
    await sqlite.close();
  }
}

async function seed(database: LocalDatabase): Promise<void> {
  await database.exec(
    "CREATE TABLE values_table(i INTEGER, r REAL, t TEXT, b BLOB, n INTEGER); INSERT INTO values_table VALUES(0, 0.5, 'text', x'0001ff', NULL)",
  );
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!onBun)("sqlite engine value compatibility", () => {
  it("matches Turso for INTEGER, REAL, TEXT, BLOB and NULL", async () => {
    await pair(async (turso, sqlite) => {
      await seed(turso);
      await seed(sqlite);
      for (const query of [
        "SELECT i, r, t, b, n FROM values_table",
        "SELECT i, r, t, b, n FROM values_table",
      ]) {
        const left = (await turso.all(query)) as Record<string, unknown>[];
        const right = (await sqlite.all(query)) as Record<string, unknown>[];
        expect(right).toEqual(left);
        expect(right[0].b).toBeInstanceOf(Buffer);
        expect(right[0].n).toBeNull();
      }
      const blobStatement = await sqlite.prepare("SELECT b FROM values_table");
      expect(await blobStatement.raw().get()).toEqual([Buffer.from([0, 1, 255])]);
      expect(await blobStatement.pluck().get()).toEqual(Buffer.from([0, 1, 255]));
      blobStatement.close();
    });
  });

  it("matches Turso around the safe-integer boundaries", async () => {
    await pair(async (turso, sqlite) => {
      const boundaries = [
        "1",
        "-1",
        "0",
        "9007199254740991",
        "-9007199254740991",
        "9007199254740992",
        "-9007199254740992",
        "9007199254740993",
        "-9007199254740993",
        "9223372036854775807",
        "-9223372036854775808",
      ];
      for (const literal of boundaries) {
        const query = `SELECT ${literal} AS value`;
        expect(await sqlite.get(query)).toEqual(await turso.get(query));
        const safe = await (await sqlite.prepare(query)).safeIntegers(true).get();
        expect(safe).toEqual({ value: BigInt(literal) });
        const statement = await sqlite.prepare(query);
        expect(await statement.safeIntegers(false).get()).toEqual(await turso.get(query));
        statement.close();
      }
      expect(
        Number.isSafeInteger(
          (
            (await sqlite.get("SELECT 9007199254740993 AS v")) as {
              v: number;
            }
          ).v,
        ),
      ).toBe(false);
    });
  });

  it("keeps bigint precision through bigint bindings and safeIntegers reads", async () => {
    await pair(async (turso, sqlite) => {
      for (const database of [turso, sqlite]) {
        await database.exec("CREATE TABLE big(i INTEGER)");
        await database.run("INSERT INTO big VALUES(?)", 9007199254740993n);
        expect(await database.get("SELECT i FROM big")).toEqual({ i: 9007199254740992 });
        const exactStatement = await database.prepare("SELECT i FROM big");
        const exact = await exactStatement.safeIntegers(true).get();
        exactStatement.close();
        expect(exact).toEqual({ i: 9007199254740993n });
      }
    });
  });

  it("reads REAL values without turning whole floats into bigints", async () => {
    await pair(async (turso, sqlite) => {
      for (const database of [turso, sqlite]) {
        expect(await database.get("SELECT 2.0 AS value")).toEqual({ value: 2 });
        const realStatement = await database.prepare(
          "SELECT 2.0 AS value, CAST(7 AS REAL) AS cast",
        );
        const safe = await realStatement.safeIntegers(true).get();
        expect(safe).toEqual(await database.get("SELECT 2.0 AS value, CAST(7 AS REAL) AS cast"));
        realStatement.close();
      }
    });
  });

  it("round-trips booleans, dates, blobs and JSON through Drizzle", async () => {
    const table = sqliteTable("drizzle_values", {
      id: integer().primaryKey(),
      payload: blob({ mode: "buffer" }),
      json: text(),
      flag: integer({ mode: "boolean" }),
      at: integer({ mode: "timestamp_ms" }),
    });
    const client = withEngine("sqlite", () => createLocalDatabase(temporaryFile()));
    const db = drizzle({ client });
    try {
      await client.exec(
        "CREATE TABLE drizzle_values(id INTEGER PRIMARY KEY, payload BLOB, json TEXT, flag INTEGER, at INTEGER)",
      );
      await db.insert(table).values({
        id: 1,
        payload: Buffer.from([0, 255, 16]),
        json: JSON.stringify({ nested: { ok: true } }),
        flag: true,
        at: new Date(1_700_000_000_000),
      });
      await db.insert(table).values({ id: 2, flag: false });
      const rows = await db.select().from(table).orderBy(table.id);
      expect(rows[0].payload).toEqual(Buffer.from([0, 255, 16]));
      expect(rows[0].flag).toBe(true);
      expect(rows[0].at).toEqual(new Date(1_700_000_000_000));
      expect(rows[1].flag).toBe(false);
      expect(rows[1].payload).toBeNull();
      expect(JSON.parse(rows[0].json!)).toEqual({ nested: { ok: true } });
      expect(
        await client.get("SELECT json_extract(json,'$.nested.ok') AS ok FROM drizzle_values"),
      ).toEqual({ ok: 1 });
    } finally {
      await client.close();
    }
  });

  it("keeps project-scoped rows isolated through the sqlite engine", async () => {
    const client = withEngine("sqlite", () => createLocalDatabase(temporaryFile()));
    try {
      await client.exec(
        "CREATE TABLE scoped(project_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id, value))",
      );
      await client.run("INSERT INTO scoped VALUES('a','1'),('b','2')");
      expect(await client.all("SELECT value FROM scoped WHERE project_id=?", "a")).toEqual([
        { value: "1" },
      ]);
      expect(await client.all("SELECT value FROM scoped WHERE project_id=?", "b")).toEqual([
        { value: "2" },
      ]);
      await expect(client.run("INSERT INTO scoped VALUES('a','1')")).rejects.toThrow(
        "UNIQUE constraint failed",
      );
    } finally {
      await client.close();
    }
  });
});
