import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openLocalDatabase, withLocalTransaction } from "./local";
import {
  assertReadSnapshotSupported,
  getReadSnapshotCapability,
  type ReadSnapshotMetrics,
  runReadSnapshot,
  withReadSnapshot,
} from "./read-snapshot";
import { assertSnapshotSql } from "./read-snapshot-executor";
import { getLocalReadSnapshotProvider } from "./read-snapshot-local";

const root = "SELECT hash FROM roots WHERE project_id='p' AND id=1";
const chunk = "SELECT body FROM chunks WHERE project_id='p' AND hash=1";

async function snapshotContract(engine: "turso") {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-snapshot-"));
  const previous = process.env.PERIFUSE_ENGINE;
  process.env.PERIFUSE_ENGINE = engine;
  const writer = await openLocalDatabase(join(directory, "test.db"));
  await writer.exec(
    "CREATE TABLE roots(project_id TEXT,id INTEGER,hash INTEGER); CREATE TABLE chunks(project_id TEXT,hash INTEGER,body TEXT)",
  );
  const reader = await openLocalDatabase(join(directory, "test.db"), true);
  try {
    for (const mutation of [
      "DELETE FROM roots WHERE project_id='p'",
      "UPDATE roots SET hash=2 WHERE project_id='p'",
    ]) {
      await writer.exec(
        "DELETE FROM roots; INSERT INTO roots VALUES('p',1,1); INSERT INTO chunks VALUES('p',1,'old')",
      );
      const metrics: ReadSnapshotMetrics[] = [];
      await runReadSnapshot(
        getLocalReadSnapshotProvider(reader),
        async (tx) => {
          expect(await tx.get(root)).toEqual({ hash: 1 });
          expect(await tx.get(chunk)).toEqual({ body: "old" });
          await withLocalTransaction(writer, async (write) => {
            await write.exec(mutation);
            await write.exec("DELETE FROM chunks WHERE project_id='p'");
          });
          expect(await tx.get(root)).toEqual({ hash: 1 });
          const statement = await tx.prepare(chunk);
          expect(await statement.get()).toEqual({ body: "old" });
          expect(await tx.all(chunk)).toEqual([{ body: "old" }]);
          const rows = [];
          for await (const row of tx.iterate(chunk)) rows.push(row);
          expect(rows).toEqual([{ body: "old" }]);
          await expect(tx.exec("DELETE FROM chunks")).rejects.toThrow("read-only");
        },
        { onMetrics: (metric) => metrics.push(metric) },
      );
      expect(await reader.all(chunk)).toEqual([]);
      expect(metrics).toEqual([expect.objectContaining({ engine, outcome: "success" })]);
      expect(metrics[0].waitMs).toBeGreaterThanOrEqual(0);
      expect(metrics[0].snapshotMs).toBeGreaterThan(0);
    }
    // 固定版本的 no-go 反例：构造参数 readonly 被引擎忽略，不能据此开放 CAS。
    await reader.exec("INSERT INTO chunks VALUES('p',99,'readonly violation')");
    expect(await writer.get("SELECT body FROM chunks WHERE hash=99")).toEqual({
      body: "readonly violation",
    });
    expect(reader.readonly).toBe(false);
    expect(getReadSnapshotCapability(reader).supported).toBe(false);
    await expect(withReadSnapshot(reader, async (tx) => tx.get(root))).rejects.toThrow(
      "verified read snapshot",
    );
  } finally {
    await reader.close();
    await writer.close();
    if (previous === undefined) delete process.env.PERIFUSE_ENGINE;
    else process.env.PERIFUSE_ENGINE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("read snapshot", () => {
  it("Turso local：读根后并发更新/删除及 GC 不丢块", () => snapshotContract("turso"));

  it("no-go 引擎打开已有 codec 2 的库时失败，codec 0/1 不受影响", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perifuse-snapshot-startup-"));
    const filename = join(directory, "test.db");
    const previous = process.env.PERIFUSE_ENGINE;
    process.env.PERIFUSE_ENGINE = "turso";
    const db = await openLocalDatabase(filename);
    try {
      await db.exec(
        "CREATE TABLE observations(input_codec INTEGER); INSERT INTO observations VALUES(1)",
      );
      const compatible = await openLocalDatabase(filename);
      await compatible.close();
      await db.exec("INSERT INTO observations VALUES(2)");
      await expect(openLocalDatabase(filename)).rejects.toMatchObject({
        code: "PERIFUSE_READ_SNAPSHOT_UNSUPPORTED",
      });
    } finally {
      await db.close();
      if (previous === undefined) delete process.env.PERIFUSE_ENGINE;
      else process.env.PERIFUSE_ENGINE = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("指标区分 gate 等待与快照持有时间，指标异常不改变事务结果", async () => {
    const metrics: ReadSnapshotMetrics[] = [];
    const provider = {
      engine: "sqlite" as const,
      supported: true,
      async run<T>(callback: (tx: import("@tursodatabase/database").Transaction) => Promise<T>) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return callback({} as import("@tursodatabase/database").Transaction);
      },
    };
    expect(
      await runReadSnapshot(
        provider,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return 42;
        },
        { onMetrics: (metric) => metrics.push(metric) },
      ),
    ).toBe(42);
    expect(metrics[0].waitMs).toBeGreaterThanOrEqual(10);
    expect(metrics[0].snapshotMs).toBeGreaterThanOrEqual(10);
    expect(metrics[0].outcome).toBe("success");
    expect(
      await runReadSnapshot(provider, async () => 42, {
        onMetrics: () => {
          throw new Error("metric consumer failed");
        },
      }),
    ).toBe(42);
  });

  it("spy 捕获 wrapper 的 transactionAsync 后不递归，restore 后恢复", async () => {
    const previous = process.env.PERIFUSE_ENGINE;
    process.env.PERIFUSE_ENGINE = "turso";
    const db = await openLocalDatabase(":memory:");
    try {
      await db.exec("CREATE TABLE items(id)");
      // 复刻 testing.ts::rejectSql 与 probeTransactions 的捕获模式。
      const original = db.transactionAsync.bind(db);
      const spy = vi
        .spyOn(db, "transactionAsync")
        .mockImplementation((callback) => original(callback));
      await expect(
        db.transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items VALUES(1)");
          // 注入路径仍保留父句柄重入检查。
          await expect(db.get("SELECT 1 AS n")).rejects.toMatchObject({
            code: "PERIFUSE_TRANSACTION_REENTRY",
          });
          return tx.get("SELECT count(*) AS count FROM items");
        })(),
      ).resolves.toEqual({ count: 1 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
      await expect(
        db.transactionAsync(async (tx) => tx.get("SELECT count(*) AS count FROM items"))(),
      ).resolves.toEqual({ count: 1 });
    } finally {
      await db.close();
      if (previous === undefined) delete process.env.PERIFUSE_ENGINE;
      else process.env.PERIFUSE_ENGINE = previous;
    }
  });

  it("拒绝未登记的 CAS/GC 能力", () => {
    expect(() => assertReadSnapshotSupported({})).toThrow("verified read snapshot");
  });

  it("仅允许单条读查询，拒绝 CTE 写入及事务控制", () => {
    for (const sql of [
      "SELECT 1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "SELECT ';DELETE' AS value;",
    ])
      expect(() => assertSnapshotSql(sql)).not.toThrow();
    for (const sql of [
      "COMMIT",
      "PRAGMA query_only=OFF",
      "SELECT 1; DELETE FROM chunks",
      "WITH x AS (SELECT 1) DELETE FROM chunks RETURNING hash",
    ])
      expect(() => assertSnapshotSql(sql)).toThrow("read-only");
  });

  it("Turso local：异常/取消/超时释放事务，句柄失效，写事务复用", async () => {
    const previous = process.env.PERIFUSE_ENGINE;
    process.env.PERIFUSE_ENGINE = "turso";
    const db = await openLocalDatabase(":memory:");
    try {
      await db.exec("CREATE TABLE items(id)");
      await withLocalTransaction(db, async (tx) => {
        await tx.exec("INSERT INTO items VALUES(1)");
        await withReadSnapshot(tx, async (same) => {
          expect(same).toBe(tx);
          expect(await same.get("SELECT id FROM items")).toEqual({ id: 1 });
        });
      });
      await expect(
        runReadSnapshot(getLocalReadSnapshotProvider(db), async (tx) => {
          await tx.get("SELECT 1");
          throw new Error("callback failed");
        }),
      ).rejects.toThrow("callback failed");
      for (const cancel of [false, true]) {
        const controller = new AbortController();
        let stale: Parameters<Parameters<typeof withReadSnapshot>[1]>[0] | undefined;
        const metrics: ReadSnapshotMetrics[] = [];
        await expect(
          runReadSnapshot(
            getLocalReadSnapshotProvider(db),
            async (tx) => {
              stale = tx;
              await tx.get("SELECT 1");
              await expect(db.get("SELECT 1")).rejects.toThrow("transaction handle");
              if (cancel) controller.abort();
              return new Promise<never>(() => {});
            },
            { signal: controller.signal, timeoutMs: 20, onMetrics: (m) => metrics.push(m) },
          ),
        ).rejects.toMatchObject({ code: "PERIFUSE_READ_SNAPSHOT_CANCELLED" });
        await expect(stale!.get("SELECT 1")).rejects.toThrow();
        expect(await db.get("SELECT id FROM items")).toEqual({ id: 1 });
        expect(metrics[0].outcome).toBe("cancelled");
      }
    } finally {
      await db.close();
      if (previous === undefined) delete process.env.PERIFUSE_ENGINE;
      else process.env.PERIFUSE_ENGINE = previous;
    }
  });
});
