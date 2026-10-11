import { describe, expect, it } from "vitest";
import { createLocalDatabase, type LocalDatabase } from "./local";

const onBun = typeof process.versions.bun === "string";

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

async function withDatabase(run: (database: LocalDatabase) => Promise<void>): Promise<void> {
  const database = withEngine("sqlite", () => createLocalDatabase(":memory:"));
  try {
    await run(database);
  } finally {
    await database.close();
  }
}

describe.skipIf(!onBun)("sqlite engine statement", () => {
  it("lets the last raw/pluck call decide the row mode", async () => {
    await withDatabase(async (database) => {
      await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
      await database.run("INSERT INTO items VALUES(1,'a')");
      const statement = await database.prepare("SELECT id, value FROM items");
      expect(await statement.all()).toEqual([{ id: 1, value: "a" }]);
      expect(await statement.raw().all()).toEqual([[1, "a"]]);
      expect(await statement.pluck().all()).toEqual([1]);
      expect(await statement.raw(false).all()).toEqual([{ id: 1, value: "a" }]);
      expect(await statement.raw().pluck(false).all()).toEqual([{ id: 1, value: "a" }]);
      expect(await statement.pluck().raw(true).all()).toEqual([[1, "a"]]);
      expect(await statement.raw(false).pluck(true).all()).toEqual([1]);
      expect(await statement.raw(false).all()).toEqual([{ id: 1, value: "a" }]);
      expect(await statement.get()).toEqual({ id: 1, value: "a" });
      statement.close();
    });
  });

  it("keeps duplicate column positions in arrays and the last value in objects", async () => {
    await withDatabase(async (database) => {
      await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
      await database.run("INSERT INTO items VALUES(1,'a')");
      const statement = await database.prepare("SELECT id, value, id FROM items");
      expect(await statement.all()).toEqual([{ id: 1, value: "a" }]);
      expect(await statement.raw().all()).toEqual([[1, "a", 1]]);
      expect(await statement.pluck().all()).toEqual([1]);
      statement.close();

      const proto = await database.prepare("SELECT 1 AS __proto__, 2 AS constructor");
      const row = (await proto.get()) as Record<string, unknown>;
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(1);
      expect(row.constructor).toBe(2);
      proto.close();
    });
  });

  it("separates empty results, SQL NULL and undefined rows", async () => {
    await withDatabase(async (database) => {
      await database.exec("CREATE TABLE items(id INTEGER)");
      expect(await database.get("SELECT id FROM items")).toBeUndefined();
      expect(await database.all("SELECT id FROM items")).toEqual([]);
      expect(await database.get("SELECT NULL AS value")).toEqual({ value: null });
      const statement = await database.prepare("SELECT NULL AS value");
      expect(await statement.raw().get()).toEqual([null]);
      expect(await statement.pluck().get()).toBeNull();
      expect(await statement.raw(false).get()).toEqual({ value: null });
      statement.close();
    });
  });

  it("binds spread arguments, arrays, objects and buffers the way Turso does", async () => {
    await withDatabase(async (database) => {
      const statement = await database.prepare("SELECT ? AS first, ? AS second");
      expect(await statement.get(1, "x")).toEqual({ first: 1, second: "x" });
      expect(await statement.get([2, "y"])).toEqual({ first: 2, second: "y" });
      expect(await statement.get(3)).toEqual({ first: 3, second: "y" });
      expect(await statement.get(undefined, "z")).toEqual({ first: 3, second: "z" });
      expect(await statement.get()).toEqual({ first: 3, second: "z" });
      expect(await statement.get(1, 2, { queryTimeout: 5_000 })).toEqual({ first: 1, second: 2 });
      await expect(statement.get(1, 2, 3)).rejects.toThrow("parameter");
      statement.close();

      const named = await database.prepare("SELECT :id AS id, :value AS value");
      expect(await named.get({ id: 1, value: "a" })).toEqual({ id: 1, value: "a" });
      expect(await named.get({ id: 2 })).toEqual({ id: 2, value: "a" });
      expect(await named.get({})).toEqual({ id: 2, value: "a" });
      // Prefixed keys are not a second naming scheme, matching native Turso.
      expect(await named.get({ ":id": 9 })).toEqual({ id: 2, value: "a" });
      expect(await named.get(Object.assign(Object.create(null), { id: 3, value: "b" }))).toEqual({
        id: 3,
        value: "b",
      });
      await expect(named.get(new Date() as unknown as object)).rejects.toThrow(TypeError);
      named.close();

      const mixed = await database.prepare("SELECT ? AS value");
      await mixed.get(1);
      await expect(mixed.get({ value: 1 })).rejects.toThrow(TypeError);
      mixed.close();
      const other = await database.prepare("SELECT :value AS value");
      await other.get({ value: 1 });
      await expect(other.get(1)).rejects.toThrow(TypeError);
      other.close();
    });
  });

  it("copies buffer bindings and rejects unsupported values", async () => {
    await withDatabase(async (database) => {
      await database.exec("CREATE TABLE blobs(id INTEGER PRIMARY KEY, payload BLOB)");
      const backing = Buffer.from([0, 1, 2, 3, 4, 5]);
      const view = backing.subarray(2, 5);
      await database.run("INSERT INTO blobs VALUES(1,?)", view);
      backing.fill(9);
      const stored = (await database.get("SELECT payload FROM blobs WHERE id=1")) as {
        payload: Buffer;
      };
      expect(Buffer.from(stored.payload)).toEqual(Buffer.from([2, 3, 4]));
      stored.payload.fill(0);
      const reread = (await database.get("SELECT payload FROM blobs WHERE id=1")) as {
        payload: Buffer;
      };
      expect(Buffer.from(reread.payload)).toEqual(Buffer.from([2, 3, 4]));

      const statement = await database.prepare("SELECT ? AS first, ? AS second");
      for (const value of [
        new Date(),
        () => undefined,
        Symbol("value"),
        { nested: true },
        new Float32Array([1]),
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2n ** 63n,
      ])
        await expect(statement.get("anchor", value as unknown)).rejects.toThrow(TypeError);
      // One array argument expands one level, exactly like `get(1, 2)`.
      expect(await statement.get([1, 2])).toEqual({ first: 1, second: 2 });
      statement.close();
      // A lone plain object is always a named binding: against positional SQL
      // it matches nothing and leaves the parameter unbound, as Turso does.
      const positional = await database.prepare("SELECT ? AS value");
      expect(await positional.get({ positional: true } as never)).toEqual({ value: null });
      positional.close();
    });
  });

  it("reports changes and rowids without leaking earlier writes", async () => {
    await withDatabase(async (database) => {
      expect(await database.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)")).toEqual({
        changes: 0,
        lastInsertRowid: 0,
      });
      expect(await database.run("INSERT INTO items(value) VALUES('a')")).toEqual({
        changes: 1,
        lastInsertRowid: 1,
      });
      expect(await database.run("SELECT count(*) AS count FROM items")).toEqual({
        changes: 0,
        lastInsertRowid: 1,
      });
      expect(await database.run("INSERT INTO items(value) VALUES('b')")).toEqual({
        changes: 1,
        lastInsertRowid: 2,
      });
      expect(await database.run("UPDATE items SET value='c' WHERE id=1")).toEqual({
        changes: 1,
        lastInsertRowid: 2,
      });
      expect(await database.run("SELECT count(*) AS count FROM items")).toEqual({
        changes: 0,
        lastInsertRowid: 2,
      });
      expect(await database.run("CREATE INDEX items_value ON items(value)")).toEqual({
        changes: 0,
        lastInsertRowid: 2,
      });
      const returning = await database.prepare("INSERT INTO items(value) VALUES('d') RETURNING id");
      expect(await returning.get()).toEqual({ id: 3 });
      expect(await returning.columns()).toEqual([
        { name: "id", type: "INTEGER", column: null, table: null, database: null },
      ]);
      returning.close();
    });
  });

  it("closes iteration cleanly and keeps the statement reusable", async () => {
    await withDatabase(async (database) => {
      await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
      for (let id = 1; id <= 600; id++) await database.run("INSERT INTO items VALUES(?)", id);
      const statement = await database.prepare("SELECT id FROM items ORDER BY id");
      const seen: number[] = [];
      for await (const row of statement.iterate()) {
        seen.push((row as { id: number }).id);
        if (seen.length === 300) break;
      }
      expect(seen).toHaveLength(300);
      expect(seen[299]).toBe(300);
      expect(await statement.all()).toHaveLength(600);

      const failing = statement.iterate();
      await failing.next();
      await expect(failing.throw?.(new Error("consumer failure"))).rejects.toThrow(
        "consumer failure",
      );
      expect(await statement.get()).toEqual({ id: 1 });

      const mode = await database.prepare("SELECT id, id FROM items ORDER BY id LIMIT 2");
      expect(await collect(mode.raw(true).iterate())).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(await collect(mode.raw(false).pluck(true).iterate())).toEqual([1, 2]);
      expect(await collect(mode.raw(false).iterate())).toEqual([{ id: 1 }, { id: 2 }]);
      mode.close();
    });
  });

  it("materializes with a query timeout budget", async () => {
    await withDatabase(async (database) => {
      await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
      await database.run("INSERT INTO items VALUES(1)");
      for await (const row of database.iterate("SELECT id FROM items", {}, { queryTimeout: 5_000 }))
        expect(row).toEqual({ id: 1 });
      const statement = await database.prepare("SELECT id FROM items");
      await expect(async () => {
        for await (const _row of statement.iterate({}, { queryTimeout: 0.0001 }))
          await new Promise((resolve) => setTimeout(resolve, 5));
      }).rejects.toThrow(/timed out/);
      statement.close();
    });
  });
});

async function collect(source: AsyncGenerator<unknown>): Promise<unknown[]> {
  const rows: unknown[] = [];
  for await (const row of source) rows.push(row);
  return rows;
}
