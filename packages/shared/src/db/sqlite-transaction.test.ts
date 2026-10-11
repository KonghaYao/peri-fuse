import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalMigrations,
  createLocalDatabase,
  type LocalDatabase,
  openLocalDatabase,
  type Transaction,
  withLocalTransaction,
} from "./local";
import { rejectSql } from "./testing";

const onBun = typeof process.versions.bun === "string";
const directories: string[] = [];
const REENTRY = { code: "PERIFUSE_TRANSACTION_REENTRY" };

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

function temporaryFile(name = "transaction.db"): string {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-sqlite-tx-"));
  directories.push(directory);
  return join(directory, name);
}

const memoryDatabase = () => withEngine("sqlite", () => openLocalDatabase(":memory:"));

async function drain(source: AsyncGenerator<unknown>): Promise<void> {
  for await (const _row of source) void _row;
}

async function createItems(database: LocalDatabase): Promise<void> {
  await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe.skipIf(!onBun)("sqlite engine transactions", () => {
  it("runs every transaction shape with the caller arguments and result", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      const callback = async (tx: Transaction, ...args: unknown[]) => {
        expect((tx as unknown as { open: boolean }).open).toBe(true);
        await tx.run("INSERT INTO items VALUES(?,?)", args[0] as number, args[1] as string);
        return await tx.get("SELECT value FROM items WHERE id=?", args[0] as number);
      };
      expect(await database.transactionAsync(callback)(1, "default")).toEqual({ value: "default" });
      expect(await database.transactionAsync(callback).deferred(2, "deferred")).toEqual({
        value: "deferred",
      });
      expect(await database.transactionAsync(callback).immediate(3, "immediate")).toEqual({
        value: "immediate",
      });
      expect(await database.transactionAsync(callback).exclusive(4, "exclusive")).toEqual({
        value: "exclusive",
      });
      expect(await database.get("SELECT count(*) AS count FROM items")).toEqual({ count: 4 });
    } finally {
      await database.close();
    }
  });

  it("rolls callback failures back and keeps the connection usable", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      await database.run("INSERT INTO items VALUES(1,'a')");
      await expect(
        database
          .transactionAsync(async (tx) => {
            await tx.run("INSERT INTO items VALUES(2,'b')");
            throw new Error("callback failed");
          })
          .immediate(),
      ).rejects.toThrow("callback failed");
      expect(await database.all("SELECT id FROM items")).toEqual([{ id: 1 }]);
      await database
        .transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items VALUES(3,'c')");
        })
        .immediate();
      expect(await database.all("SELECT id FROM items")).toEqual([{ id: 1 }, { id: 3 }]);
    } finally {
      await database.close();
    }
  });

  it("rejects a non-function callback synchronously", async () => {
    const database = await memoryDatabase();
    try {
      expect(() => database.transactionAsync("nope" as unknown as () => Promise<void>)).toThrow(
        TypeError,
      );
    } finally {
      await database.close();
    }
  });

  it("rejects every read-only transaction shape without running the callback", async () => {
    const filename = temporaryFile();
    const writable = await withEngine("sqlite", () => openLocalDatabase(filename));
    await createItems(writable);
    await writable.close();
    const readonly = withEngine("sqlite", () => createLocalDatabase(filename, true));
    try {
      const callback = vi.fn(async () => undefined);
      for (const shape of [
        () => readonly.transactionAsync(callback)(),
        () => readonly.transactionAsync(callback).deferred(),
        () => readonly.transactionAsync(callback).immediate(),
        () => readonly.transactionAsync(callback).exclusive(),
      ])
        await expect(shape()).rejects.toThrow("read-only");
      expect(callback).not.toHaveBeenCalled();
    } finally {
      await readonly.close();
    }
  });

  it("fails parent re-entry fast instead of deadlocking, including detached tasks", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      let detached: Promise<unknown> | undefined;
      await database
        .transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items VALUES(1,'a')");
          for (const call of [
            () => database.run("INSERT INTO items VALUES(2,'b')"),
            () => database.get("SELECT count(*) AS count FROM items"),
            () => database.all("SELECT count(*) AS count FROM items"),
            () => database.exec("INSERT INTO items VALUES(3,'c')"),
            () => database.prepare("SELECT 1 AS value"),
            () => database.close(),
            () => database.transactionAsync(async () => undefined)(),
          ])
            await expect(call()).rejects.toMatchObject(REENTRY);
          await expect(drain(database.iterate("SELECT 1 AS value"))).rejects.toMatchObject(REENTRY);
          // A task that inherited the scope still fails after the callback ends.
          detached = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
            database.get("SELECT 1 AS value"),
          );
        })
        .immediate();
      await expect(detached).rejects.toMatchObject(REENTRY);
      expect(await database.all("SELECT id FROM items")).toEqual([{ id: 1 }]);
      expect(await database.get("SELECT 1 AS value")).toEqual({ value: 1 });
    } finally {
      await database.close();
    }
  });

  it("invalidates the handle and its statements once the transaction finished", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      let handle: Transaction | undefined;
      let statement: { get(): Promise<unknown> } | undefined;
      await database
        .transactionAsync(async (tx) => {
          handle = tx;
          statement = (await tx.prepare("SELECT value FROM items")) as unknown as {
            get(): Promise<unknown>;
          };
        })
        .immediate();
      expect((handle as unknown as { open: boolean }).open).toBe(false);
      await expect(handle!.run("INSERT INTO items VALUES(1,'a')")).rejects.toMatchObject({
        code: "PERIFUSE_TRANSACTION_CLOSED",
      });
      await expect(statement!.get()).rejects.toThrow("Statement is closed");
      await expect(
        database
          .transactionAsync(async (tx) => {
            await tx.run("INSERT INTO items VALUES(2,'b')");
            return await tx.get("SELECT value FROM items WHERE id=2");
          })
          .immediate(),
      ).resolves.toEqual({ value: "b" });
    } finally {
      await database.close();
    }
  });

  it("serializes concurrent transaction statements in call order", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      await database
        .transactionAsync(async (tx) => {
          await Promise.all([
            tx.run("INSERT INTO items VALUES(1,'a')"),
            tx.run("INSERT INTO items VALUES(2,'b')"),
            tx.run("INSERT INTO items VALUES(3,'c')"),
          ]);
          expect(await tx.all("SELECT id FROM items ORDER BY id")).toEqual([
            { id: 1 },
            { id: 2 },
            { id: 3 },
          ]);
        })
        .immediate();
      expect(await database.get("SELECT count(*) AS count FROM items")).toEqual({ count: 3 });
    } finally {
      await database.close();
    }
  });

  it("queues other requests behind the transaction without mixing them in", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      const order: string[] = [];
      const transaction = database
        .transactionAsync(async (tx) => {
          order.push("begin");
          await tx.run("INSERT INTO items VALUES(1,'a')");
          await new Promise((resolve) => setTimeout(resolve, 20));
          await tx.run("INSERT INTO items VALUES(2,'b')");
          order.push("end");
        })
        .immediate();
      const queued = database.get("SELECT count(*) AS count FROM items").then((row) => {
        order.push("queued");
        return row;
      });
      await expect(transaction).resolves.toBeUndefined();
      expect(await queued).toEqual({ count: 2 });
      expect(order).toEqual(["begin", "end", "queued"]);
    } finally {
      await database.close();
    }
  });

  it("reuses the transaction handle in withLocalTransaction(tx) and commits the outer transaction", async () => {
    const database = await memoryDatabase();
    try {
      await createItems(database);
      await database
        .transactionAsync(async (tx) => {
          await withLocalTransaction(tx as unknown as LocalDatabase, async (inner) => {
            await inner.run("INSERT INTO items VALUES(1,'a')");
          });
          await tx.run("INSERT INTO items VALUES(2,'b')");
        })
        .immediate();
      expect(await database.all("SELECT id FROM items ORDER BY id")).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      await withLocalTransaction(database, async (tx) => {
        await tx.run("INSERT INTO items VALUES(3,'c')");
      });
      expect(await database.get("SELECT count(*) AS count FROM items")).toEqual({ count: 3 });
    } finally {
      await database.close();
    }
  });

  it("rolls a failing transaction back through the testing.ts rejectSql helper", async () => {
    const database = await memoryDatabase();
    const db = drizzle({ client: database });
    try {
      await createItems(database);
      const fault = rejectSql(database, /INSERT INTO items/i, vi);
      try {
        await expect(
          withLocalTransaction(database, async (tx) => {
            await tx.run("INSERT INTO items VALUES(1,'a')");
          }),
        ).rejects.toThrow("synthetic database failure");
      } finally {
        fault.mockRestore();
      }
      expect(await database.get("SELECT count(*) AS count FROM items")).toEqual({ count: 0 });
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO items VALUES(2,'b')");
      });
      expect(await database.all("SELECT id FROM items")).toEqual([{ id: 2 }]);
    } finally {
      await database.close();
    }
  });

  it("keeps an outer transaction committable after a nested savepoint rollback", async () => {
    const database = await memoryDatabase();
    const db = drizzle({ client: database });
    try {
      await createItems(database);
      await db.transaction(
        async (tx) => {
          await tx.run("INSERT INTO items VALUES(1,'a')");
          await expect(
            tx.transaction(async (nested) => {
              await nested.run("INSERT INTO items VALUES(2,'b')");
              throw new Error("savepoint failure");
            }),
          ).rejects.toThrow("savepoint failure");
          await tx.run("INSERT INTO items VALUES(3,'c')");
        },
        { behavior: "immediate" },
      );
      expect(await database.all("SELECT id FROM items ORDER BY id")).toEqual([
        { id: 1 },
        { id: 3 },
      ]);
    } finally {
      await database.close();
    }
  });

  it("rolls a failed migration back and keeps earlier migrations", async () => {
    const database = await memoryDatabase();
    try {
      const baseline = {
        name: "001/migration.sql",
        sql: "CREATE TABLE items(id TEXT PRIMARY KEY)",
      };
      await applyLocalMigrations(database, [baseline]);
      await expect(
        applyLocalMigrations(database, [
          baseline,
          {
            name: "002/migration.sql",
            sql: "INSERT INTO items VALUES('failed'); --> statement-breakpoint\nINSERT INTO missing VALUES(1)",
          },
        ]),
      ).rejects.toThrow();
      expect(await database.get("SELECT count(*) AS count FROM items")).toEqual({ count: 0 });
      expect(await database.get("SELECT count(*) AS count FROM _perifuse_migrations")).toEqual({
        count: 1,
      });
    } finally {
      await database.close();
    }
  });
});

describe.skipIf(!onBun)("sqlite engine transaction modes under contention", () => {
  it("lets a deferred transaction begin while another connection holds the write lock", async () => {
    const filename = temporaryFile();
    const writer = await withEngine("sqlite", () => openLocalDatabase(filename));
    const reader = await withEngine("sqlite", () => openLocalDatabase(filename));
    try {
      await createItems(writer);
      await writer.run("INSERT INTO items VALUES(1,'held')");
      await writer.exec("BEGIN IMMEDIATE");
      await writer.run("INSERT INTO items VALUES(2,'uncommitted')");
      let ran = false;
      await expect(
        reader
          .transactionAsync(async (tx) => {
            ran = true;
            await tx.run("INSERT INTO items VALUES(3,'deferred')");
          })
          .deferred(),
      ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(ran).toBe(true);
      expect(await reader.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
      await writer.exec("COMMIT");
      expect(await reader.get("SELECT count(*) AS count FROM items")).toEqual({ count: 2 });
      await reader
        .transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items VALUES(4,'after')");
        })
        .immediate();
      expect(await reader.get("SELECT count(*) AS count FROM items")).toEqual({ count: 3 });
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  it("does not let an exclusive transaction block WAL readers", async () => {
    const filename = temporaryFile();
    const writer = withEngine("sqlite", () => createLocalDatabase(filename));
    const reader = await withEngine("sqlite", () => openLocalDatabase(filename));
    try {
      await writer.connect();
      await reader.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
      await reader.run("INSERT INTO items VALUES(1,'committed')");
      await writer
        .transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items VALUES(2,'pending')");
          expect(await reader.get("SELECT value FROM items WHERE id=2")).toBeUndefined();
          expect(await reader.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
        })
        .exclusive();
      expect(await reader.get("SELECT count(*) AS count FROM items")).toEqual({ count: 2 });
    } finally {
      await reader.close();
      await writer.close();
    }
  });
});
