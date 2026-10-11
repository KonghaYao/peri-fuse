import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyLocalMigrations, openLocalDatabase } from "./local";
import { createSqliteDatabase } from "./sqlite";
import { BEGIN_RETRY_BUDGET_MS, type RetryClock } from "./sqlite-transaction";

// Every connection in this file must use the sqlite engine; vitest isolates
// test files, so the module-scoped switch cannot leak into other suites.
process.env.PERIFUSE_ENGINE = "sqlite";

const onBun = typeof process.versions.bun === "string";
const directories: string[] = [];
const pressure = process.env.PERIFUSE_SQLITE_PRESSURE === "1";

function temporaryFile(name = "concurrency.db"): string {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-sqlite-busy-"));
  directories.push(directory);
  return join(directory, name);
}

interface TestClock extends RetryClock {
  readonly sleeps: number[];
  readonly elapsed: number;
}

/** Deterministic clock: time advances only when the retry loop sleeps. */
function createClock(): TestClock {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    random: () => 0.5,
    get elapsed() {
      return current;
    },
  };
}

async function createItems(database: { exec(sql: string): Promise<void> }): Promise<void> {
  await database.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!onBun)("sqlite engine busy handling", () => {
  it("retries BEGIN with the documented schedule until the budget expires", async () => {
    const filename = temporaryFile();
    const holder = await openLocalDatabase(filename);
    const clock = createClock();
    const waiter = createSqliteDatabase(filename, false, { clock });
    try {
      await createItems(holder);
      await holder.exec("BEGIN IMMEDIATE");
      await holder.run("INSERT INTO items VALUES(1,'held')");
      const callback = async () => "never";
      await expect(waiter.transactionAsync(callback).immediate()).rejects.toMatchObject({
        code: "SQLITE_BUSY",
        elapsedMs: expect.any(Number),
        attempts: expect.any(Number),
      });
      expect(clock.sleeps.slice(0, 5)).toEqual([22.5, 32.5, 52.5, 92.5, 172.5]);
      expect(clock.sleeps[5]).toBe(212.5);
      expect(clock.elapsed).toBeGreaterThanOrEqual(BEGIN_RETRY_BUDGET_MS);
      await expect(waiter.transactionAsync(callback).immediate()).rejects.toThrow(/attempts=\d+/);
    } finally {
      await holder.exec("COMMIT");
      await holder.close();
      await waiter.close();
    }
  });

  it("runs the callback exactly once when the competing writer releases the lock", async () => {
    const filename = temporaryFile();
    const holder = await openLocalDatabase(filename);
    const waiter = await openLocalDatabase(filename);
    try {
      await createItems(holder);
      await holder.exec("BEGIN IMMEDIATE");
      await holder.run("INSERT INTO items VALUES(1,'held')");
      let calls = 0;
      const transaction = waiter
        .transactionAsync(async (tx) => {
          calls += 1;
          await tx.run("INSERT INTO items VALUES(2,'waited')");
          return calls;
        })
        .immediate();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await holder.exec("COMMIT");
      await expect(transaction).resolves.toBe(1);
      expect(calls).toBe(1);
      expect(await waiter.get("SELECT count(*) AS count FROM items")).toEqual({ count: 2 });
    } finally {
      await holder.close();
      await waiter.close();
    }
  });

  it("fails ordinary statements and exec immediately instead of retrying them", async () => {
    const filename = temporaryFile();
    const holder = await openLocalDatabase(filename);
    const clock = createClock();
    const waiter = createSqliteDatabase(filename, false, { clock });
    try {
      await createItems(holder);
      await holder.exec("BEGIN IMMEDIATE");
      await holder.run("INSERT INTO items VALUES(1,'held')");
      await expect(waiter.run("INSERT INTO items VALUES(2,'blocked')")).rejects.toMatchObject({
        code: "SQLITE_BUSY",
      });
      await expect(waiter.exec("INSERT INTO items VALUES(3,'blocked')")).rejects.toMatchObject({
        code: "SQLITE_BUSY",
      });
      // WAL readers are never blocked by the writer, and they are not retried.
      // The uncommitted row stays invisible to them.
      expect(await waiter.get("SELECT count(*) AS count FROM items")).toEqual({ count: 0 });
      await expect(
        waiter.get("INSERT INTO items VALUES(4,'blocked') RETURNING id"),
      ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(clock.sleeps).toEqual([]);
    } finally {
      await holder.exec("COMMIT");
      await holder.close();
      await waiter.close();
    }
  });

  it("rolls a failing COMMIT back without retrying and keeps the connection usable", async () => {
    const database = await openLocalDatabase(temporaryFile());
    const clock = createClock();
    const traced = createSqliteDatabase(database.name, false, { clock });
    try {
      await database.exec(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
      );
      await expect(
        traced
          .transactionAsync(async (tx) => {
            await tx.run("INSERT INTO child VALUES(1,99)");
          })
          .immediate(),
      ).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
      expect(clock.sleeps).toEqual([]);
      expect(await traced.get("SELECT count(*) AS count FROM child")).toEqual({ count: 0 });
      await traced
        .transactionAsync(async (tx) => {
          await tx.run("INSERT INTO parent VALUES(1)");
        })
        .immediate();
      expect(await traced.get("SELECT count(*) AS count FROM parent")).toEqual({ count: 1 });
    } finally {
      await database.close();
      await traced.close();
    }
  });

  it("surfaces a DEFERRED snapshot conflict without replaying the transaction", async () => {
    const filename = temporaryFile();
    const writer = await openLocalDatabase(filename);
    const reader = await openLocalDatabase(filename);
    try {
      await createItems(writer);
      await writer.run("INSERT INTO items VALUES(1,'first')");
      let calls = 0;
      await expect(
        reader
          .transactionAsync(async (tx) => {
            calls += 1;
            expect(await tx.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
            await writer.run("INSERT INTO items VALUES(2,'committed during snapshot')");
            await tx.run("INSERT INTO items VALUES(3,'snapshot')");
          })
          .deferred(),
      ).rejects.toMatchObject({ code: "SQLITE_BUSY_SNAPSHOT" });
      expect(calls).toBe(1);
      expect(await reader.get("SELECT count(*) AS count FROM items")).toEqual({ count: 2 });
      expect(await writer.get("SELECT count(*) AS count FROM items")).toEqual({ count: 2 });
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  it("applies a migration once when two connections race for it", async () => {
    const filename = temporaryFile();
    const first = await openLocalDatabase(filename);
    const second = await openLocalDatabase(filename);
    try {
      const baseline = [
        {
          name: "001/migration.sql",
          sql: "CREATE TABLE items(id INTEGER PRIMARY KEY); --> statement-breakpoint\nCREATE TABLE counter(n INTEGER NOT NULL); INSERT INTO counter VALUES(0)",
        },
      ];
      await applyLocalMigrations(first, baseline);
      const migrations = [
        ...baseline,
        {
          name: "002/migration.sql",
          sql: "INSERT INTO items VALUES(1); --> statement-breakpoint\nUPDATE counter SET n = n + 1",
        },
      ];
      await Promise.all([
        applyLocalMigrations(first, migrations),
        applyLocalMigrations(second, migrations),
        applyLocalMigrations(first, migrations),
      ]);
      expect(await first.get("SELECT n FROM counter")).toEqual({ n: 1 });
      expect(await first.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
      expect(await second.get("SELECT count(*) AS count FROM _perifuse_migrations")).toEqual({
        count: 2,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("lets writers proceed while a reader holds a snapshot, then checkpoints", async () => {
    const filename = temporaryFile();
    const writer = await openLocalDatabase(filename);
    const reader = await openLocalDatabase(filename);
    try {
      await createItems(writer);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const longRead = reader
        .transactionAsync(async (tx) => {
          expect(await tx.get("SELECT count(*) AS count FROM items")).toEqual({ count: 0 });
          await released;
          return "read";
        })
        .deferred();
      for (let index = 0; index < 200; index++)
        await writer
          .transactionAsync(async (tx) => {
            await tx.run("INSERT INTO items VALUES(?,?)", index, "value");
          })
          .immediate();
      const walBefore = statSync(`${filename}-wal`).size;
      release();
      await expect(longRead).resolves.toBe("read");
      expect(await writer.get("SELECT count(*) AS count FROM items")).toEqual({ count: 200 });
      const checkpoint = (await writer.get("PRAGMA wal_checkpoint(TRUNCATE)")) as {
        busy: number;
        checkpointed: number;
      };
      expect(checkpoint.busy).toBe(0);
      expect(walBefore).toBeGreaterThan(0);
      expect(statSync(`${filename}-wal`).size).toBeLessThanOrEqual(walBefore);
    } finally {
      await writer.close();
      await reader.close();
    }
  });
});

describe.skipIf(!onBun || !pressure)("sqlite engine pressure (PERIFUSE_SQLITE_PRESSURE=1)", () => {
  it("writes concurrently while readers hold snapshots without losing rows", async () => {
    const filename = temporaryFile("pressure.db");
    const writer = await openLocalDatabase(filename);
    const reader = await openLocalDatabase(filename);
    try {
      await writer.exec(
        "CREATE TABLE items(project_id TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY(project_id, id)); CREATE TABLE counter(project_id TEXT PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter VALUES('a',0),('b',0)",
      );
      const latencies: number[] = [];
      const committed: Record<string, number> = { a: 0, b: 0 };
      let busy = 0;
      const workers = ["a", "b", "a", "b"].map(async (projectId, workerIndex) => {
        for (let index = 0; index < 200; index++) {
          const started = performance.now();
          try {
            await writer
              .transactionAsync(async (tx) => {
                for (let row = 0; row < 5; row++)
                  await tx.run(
                    "INSERT INTO items(project_id,id) VALUES(?,?)",
                    projectId,
                    workerIndex * 1_000_000 + index * 5 + row,
                  );
                await tx.run("UPDATE counter SET n = n + 5 WHERE project_id=?", projectId);
              })
              .immediate();
            committed[projectId] += 1;
          } catch (error) {
            busy += 1;
            if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
          }
          latencies.push(performance.now() - started);
        }
      });
      const readers = [0, 1].map(async () => {
        for (let index = 0; index < 50; index++) {
          expect(
            (await reader.get("SELECT count(*) AS count FROM items")) as { count: number },
          ).toHaveProperty("count");
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      });
      await Promise.all([...workers, ...readers]);
      latencies.sort((left, right) => left - right);
      const percentile = (value: number) => latencies[Math.floor(latencies.length * value)];
      const rows = (await writer.get("SELECT count(*) AS count FROM items")) as { count: number };
      const counters = await writer.all("SELECT project_id, n FROM counter ORDER BY project_id");
      const distinct = await writer.all(
        "SELECT project_id, count(*) AS count FROM items GROUP BY project_id ORDER BY project_id",
      );
      expect(rows.count).toBe((committed.a + committed.b) * 5);
      expect(distinct).toEqual([
        { project_id: "a", count: committed.a * 5 },
        { project_id: "b", count: committed.b * 5 },
      ]);
      expect(counters).toEqual([
        { project_id: "a", n: committed.a * 5 },
        { project_id: "b", n: committed.b * 5 },
      ]);
      console.log(
        `[pressure] rows=${rows.count} busy=${busy} p50=${percentile(0.5).toFixed(2)}ms p95=${percentile(0.95).toFixed(2)}ms p99=${percentile(0.99).toFixed(2)}ms wal=${statSync(`${filename}-wal`).size}B`,
      );
    } finally {
      await writer.close();
      await reader.close();
    }
  }, 120_000);
});
