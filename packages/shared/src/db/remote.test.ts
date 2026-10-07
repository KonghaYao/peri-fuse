import { resolve } from "node:path";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteReadPool } from "../server/adapters/sqlite-read-pool";
import { SQLiteTelemetryAdapter } from "../server/adapters/sqlite-telemetry-adapter";
import { SessionSearchLifecycle } from "../server/session-search/lifecycle";
import {
  querySessionSearchRead,
  stopSessionSearchReadPool,
} from "../server/session-search/read-pool";
import { startRemoteTestServer } from "./__tests__/remote-test-server";
import { applyLocalMigrations, openLocalDatabase, readLocalMigrations } from "./local";

let server: Awaited<ReturnType<typeof startRemoteTestServer>>;
beforeEach(async () => {
  server = await startRemoteTestServer();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

describe("remote Turso HTTP storage", () => {
  it("reconnects expired idle sessions for pipeline and cursor requests", async () => {
    const client = await openLocalDatabase(server.url, false, server.authToken);
    try {
      await client.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
      await server.expireStreams();
      await client.run("INSERT INTO items VALUES(1)");
      await server.expireStreams();
      const statement = await client.prepare("SELECT id FROM items");
      expect(await statement.all()).toEqual([{ id: 1 }]);
      await server.expireStreams();
      await client.exec("INSERT INTO items VALUES(2)");
      expect(await client.get("SELECT count(*) AS count FROM items")).toEqual({ count: 2 });
    } finally {
      await client.close();
    }
  });

  it("does not reconnect an expired transaction or commit partial writes", async () => {
    const client = await openLocalDatabase(server.url, false, server.authToken);
    try {
      await client.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
      await expect(
        client.transactionAsync(async (transaction) => {
          await transaction.run("INSERT INTO items VALUES(1)");
          await server.expireStreams();
          await transaction.run("INSERT INTO items VALUES(2)");
        })(),
      ).rejects.toThrow("expired");
      expect(await client.get("SELECT count(*) AS count FROM items")).toEqual({ count: 0 });
    } finally {
      await client.close();
    }
  });

  it("protects remote read-only connections without requiring query_only support", async () => {
    const writer = await openLocalDatabase(server.url, false, server.authToken);
    await writer.exec("CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1)");
    const reader = await openLocalDatabase(server.url, true, server.authToken);
    try {
      expect(await reader.get("SELECT id FROM items")).toEqual({ id: 1 });
      const mutations = [
        "DELETE FROM items",
        "INSERT INTO items VALUES(2) RETURNING id",
        "WITH candidate AS (SELECT 1) DELETE FROM items RETURNING id",
      ];
      for (const sql of mutations) {
        await expect(reader.exec(sql)).rejects.toThrow("read-only");
        await expect(reader.run(sql)).rejects.toThrow("read-only");
        await expect(reader.get(sql)).rejects.toThrow("read-only");
        await expect(reader.all(sql)).rejects.toThrow("read-only");
        await expect(reader.prepare(sql)).rejects.toThrow("read-only");
        await expect(reader.iterate(sql).next()).rejects.toThrow("read-only");
        await expect(writer.iterate(sql).next()).rejects.toThrow("read-only");
      }
      await expect(reader.transactionAsync(async () => undefined)()).rejects.toThrow("read-only");
      await reader.exec("SELECT id FROM items; DELETE FROM items");
      expect(await writer.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
    } finally {
      await reader.close();
      await writer.close();
    }
  });

  it.each(["/tenant/database", "/tenant/database/"])(
    "preserves base path %s and query parameters in reads, transactions and streaming",
    async (basePath) => {
      await server.close();
      server = await startRemoteTestServer(basePath, "?region=eu&tag=a%2Fb&tag=c&prefix=/");
      const client = await openLocalDatabase(server.url, false, server.authToken);
      try {
        await client.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
        await client.transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items VALUES(?)", 1);
        })();
        expect(await client.get("SELECT id FROM items")).toEqual({ id: 1 });
        const rows = [];
        for await (const row of client.iterate("SELECT id FROM items")) rows.push(row);
        expect(rows).toEqual([{ id: 1 }]);
      } finally {
        await client.close();
      }
    },
  );

  it("supports bindings, JSON, blobs, Drizzle savepoints and transaction foreign keys", async () => {
    const client = await openLocalDatabase(server.url, false, server.authToken);
    const items = sqliteTable("items", {
      id: integer().primaryKey(),
      payload: blob({ mode: "buffer" }),
      json: text(),
    });
    const db = drizzle({ client });
    try {
      await client.exec(
        "CREATE TABLE items(id INTEGER PRIMARY KEY, payload BLOB, json TEXT); CREATE TABLE refs(id INTEGER REFERENCES items(id))",
      );
      await db.transaction(
        async (tx) => {
          await tx
            .insert(items)
            .values({ id: 1, payload: Buffer.from([0, 255]), json: '{"valid":true}' });
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
      expect(Buffer.from(rows[0].payload!)).toEqual(Buffer.from([0, 255]));
      expect(
        await client.get("SELECT json_extract(json,'$.valid') AS valid FROM items WHERE id=@id", {
          id: 1,
        }),
      ).toEqual({ valid: 1 });
      await expect(
        client
          .transactionAsync(async (tx) => {
            await tx.run("INSERT INTO refs VALUES(?)", 2);
          })
          .immediate(),
      ).rejects.toThrow("FOREIGN KEY");
      await expect(
        client.transactionAsync(async (tx) => {
          await tx.run("INSERT INTO items(id,json) VALUES(?,?)", 3, "rollback");
          throw new Error("rollback failure");
        })(),
      ).rejects.toThrow("rollback failure");
      expect(await client.get("SELECT count(*) AS count FROM items")).toEqual({ count: 1 });
    } finally {
      await client.close();
    }
  });

  it("applies all three domain migrations idempotently to one remote database", async () => {
    const client = await openLocalDatabase(server.url, false, server.authToken);
    try {
      for (const directory of [
        "../../drizzle",
        "../../telemetry-drizzle",
        "../../../gateway/drizzle",
      ]) {
        const migrations = readLocalMigrations(resolve(__dirname, directory));
        await applyLocalMigrations(client, migrations);
        await applyLocalMigrations(client, migrations);
      }
      expect(await client.get("SELECT count(*) AS count FROM _perifuse_migrations")).toEqual({
        count: 3,
      });
      expect(await client.get("SELECT count(*) AS count FROM api_keys")).toEqual({ count: 0 });
      expect(await client.get("SELECT count(*) AS count FROM traces")).toEqual({ count: 0 });
      expect(await client.get("SELECT count(*) AS count FROM provider")).toEqual({ count: 0 });
    } finally {
      await client.close();
    }
  });

  it("uses authenticated remote worker reads with row limits and project-scoped search", async () => {
    await server.close();
    server = await startRemoteTestServer("/tenant/database/", "?region=eu&tag=a%2Fb&tag=c");
    vi.stubEnv("TURSO_DATABASE_URL", server.url);
    vi.stubEnv("TURSO_AUTH_TOKEN", server.authToken);
    const adapter = new SQLiteTelemetryAdapter();
    const pool = new SqliteReadPool(server.url, 1, { timeoutMs: 5000 }, server.authToken);
    const lifecycle = new SessionSearchLifecycle(adapter.getDatabase());
    try {
      await adapter.initialize();
      await adapter
        .getDatabase()
        .run(
          "INSERT INTO traces(id,project_id,session_id,timestamp,input,output,is_deleted) VALUES(?,?,?,?,?,?,0)",
          "remote-trace",
          "project-a",
          "session-a",
          "2026-10-07 00:00:00",
          '{"messages":[{"role":"user","content":"remote search example"}]}',
          "null",
        );
      expect(
        await pool.query("SELECT id FROM traces WHERE project_id=@projectId", {
          projectId: "project-a",
        }),
      ).toEqual([{ id: "remote-trace" }]);
      expect(
        await pool.query("SELECT id FROM traces WHERE project_id=@projectId", {
          projectId: "project-b",
        }),
      ).toEqual([]);
      await expect(
        pool.query("SELECT 1 AS n UNION ALL SELECT 2", {}, { maxResultRows: 1 }),
      ).rejects.toMatchObject({ code: "RESULT_LIMIT" });
      lifecycle.start();
      await vi.waitFor(
        async () => {
          expect(
            await adapter
              .getDatabase()
              .get(
                "SELECT count(*) AS count FROM search_occurrences WHERE project_id=?",
                "project-a",
              ),
          ).toMatchObject({ count: 1 });
        },
        { timeout: 15000, interval: 150 },
      );
      expect(
        await querySessionSearchRead(
          adapter,
          "SELECT source_id FROM search_occurrences WHERE project_id=@projectId",
          { projectId: "project-a" },
          undefined,
          5000,
        ),
      ).toEqual([{ source_id: "remote-trace" }]);
      expect(server.requestCount()).toBeGreaterThan(10);
    } finally {
      await lifecycle.stop();
      await stopSessionSearchReadPool(adapter);
      await pool.close();
      await adapter.close();
    }
  }, 30000);

  it.each([undefined, "wrong-token"])(
    "reports server authentication failures for token %s without local fallback",
    async (authToken) => {
      await expect(openLocalDatabase(server.url, false, authToken)).rejects.toThrow("401");
      expect(server.requestCount()).toBeGreaterThan(0);
    },
  );
});
