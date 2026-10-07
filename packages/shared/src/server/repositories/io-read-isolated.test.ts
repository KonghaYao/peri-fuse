import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "../adapters/sqlite-telemetry-adapter";
import { getSessionContext } from "../session-search/context";
import { processDirty } from "../session-search/indexer";
import { stopSessionSearchReadPool } from "../session-search/read-pool";
import { SessionSearchStorage } from "../session-search/storage";
import { applyInputOutputRendering } from "../utils/rendering";
import {
  liteGetObservationById,
  liteGetObservationsForTraces,
  liteGetObservationsTable,
  liteGetTraceById,
  liteGetTracesTable,
} from "./lite-queries";

let db: SQLiteTelemetryAdapter;
vi.mock("../adapters", async (original) => ({
  ...(await original<typeof import("../adapters")>()),
  getTelemetryDB: () => db,
}));
afterEach(async () => {
  if (db) await stopSessionSearchReadPool(db);
  await db?.close();
  vi.unstubAllEnvs();
});

it.each(["0", "1"])("真实 SQLite repository 解码、批量与预算 workers=%s", async (workers) => {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  vi.stubEnv("PERIFUSE_READ_WORKERS", workers);
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
  const file = join(dirname(base), `read-path-${workers}.db`);
  db = new SQLiteTelemetryAdapter(file);
  await db.initialize();
  const input = JSON.stringify({
    messages: [{ role: "user", content: "无损 Unicode 中文𝄞 ".repeat(2000) }],
  });
  for (const project_id of ["p", "other"]) {
    await db.insert({
      table: "traces",
      records: [{ id: "t", project_id, timestamp: "2026-01-01 00:00:00", input, output: "" }],
    });
    await db.insert({
      table: "observations",
      records: [
        {
          id: "o",
          trace_id: "t",
          project_id,
          start_time: "2026-01-01 00:00:00",
          input,
          output: "",
        },
      ],
    });
  }
  const physical = (await db
    .getDatabase()
    .get(
      "SELECT length(input) AS n, input_raw_size AS raw, input_codec AS codec FROM traces WHERE project_id='p'",
    )) as { n: number; raw: number; codec: number };
  expect(physical.codec).toBe(1);
  expect(physical.n).toBeLessThan(physical.raw / 10);
  await db.close();
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "off");
  db = new SQLiteTelemetryAdapter(file);
  await db.initialize();
  await db.insert({
    table: "traces",
    records: [
      { id: "legacy", project_id: "p", timestamp: "2026-01-01 00:00:00", input: "", output: null },
    ],
  });
  expect((await liteGetTraceById("p", "t"))?.input).toBe(input);
  expect((await liteGetTraceById("p", "legacy"))?.input).toBe("");
  expect((await liteGetTraceById("p", "legacy"))?.output).toBeNull();
  expect(await liteGetTraceById("absent", "t")).toBeUndefined();
  const rows = await liteGetTracesTable({ projectId: "p", includeIO: true });
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === "t")?.output).toBe("");
  expect((await liteGetObservationById("p", "o"))?.input).toBe(input);
  expect((await liteGetObservationsTable("p"))[0].output).toBe("");
  const spy = vi.spyOn(db, "query");
  const batch = await liteGetObservationsForTraces("p", ["t", "legacy"], true);
  expect(batch.get("t")?.[0].input).toBe(input);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  await expect(
    db.query({
      query: "SELECT input,input_codec,input_raw_size FROM traces WHERE project_id='p' AND id='t'",
      maxResultBytes: 4096,
    }),
  ).rejects.toThrow("limit");
  expect(applyInputOutputRendering("", { truncated: false, shouldJsonParse: true })).toBe("");
  for (const table of ["traces", "observations"]) {
    await db.getDatabase().run(`UPDATE ${table} SET input_codec=99 WHERE project_id='p'`);
  }
  expect((await liteGetTraceById("p", "t", true, true))?.input).toBeNull();
  expect(await liteGetTracesTable({ projectId: "p", includeIO: false })).toHaveLength(2);
  expect((await liteGetObservationsForTraces("p", ["t"], false)).get("t")?.[0].input).toBeNull();
  await expect(liteGetTraceById("p", "t")).rejects.toThrow("IO_COMPRESSION_VERSION");
  await expect(liteGetObservationsForTraces("p", ["t"], true)).rejects.toThrow(
    "IO_COMPRESSION_VERSION",
  );
  await expect(liteGetObservationsTable("p")).rejects.toThrow("IO_COMPRESSION_VERSION");
  expect((await liteGetTraceById("other", "t"))?.input).toBe(input);
});

it("search 按原正文体积标记 limited，损坏标记 failed，不静默成功", async () => {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
  db = new SQLiteTelemetryAdapter(join(dirname(base), "search-compressed.db"));
  await db.initialize();
  const sql = db.getDatabase();
  for (const [id, input] of [
    [
      "ok",
      JSON.stringify({ messages: [{ role: "user", content: "压缩搜索 needle ".repeat(500) }] }),
    ],
    ["large", "x".repeat(2 * 1024 * 1024 + 1)],
    ["bad", "x".repeat(2000)],
  ]) {
    await db.insert({
      table: "traces",
      records: [{ id, project_id: "p", timestamp: "2026-01-01 00:00:00", input }],
    });
    await new SessionSearchStorage(sql).markDirty({
      projectId: "p",
      kind: "trace",
      id,
      revision: 1,
    });
  }
  await sql.run("UPDATE traces SET input_codec=99 WHERE id='bad'");
  await processDirty(sql);
  expect(
    (
      (await sql.get("SELECT COUNT(*) AS n FROM search_occurrences WHERE source_id='ok'")) as {
        n: number;
      }
    ).n,
  ).toBeGreaterThan(0);
  expect(
    await sql.get("SELECT COUNT(*) AS n FROM search_occurrences WHERE source_id='large'"),
  ).toMatchObject({ n: 0 });
  const anchor = (await sql.get(
    "SELECT occurrence_id, source_version FROM search_occurrences WHERE project_id='p' AND source_id='ok' LIMIT 1",
  )) as { occurrence_id: string; source_version: number };
  const context = await getSessionContext("p", {
    occurrenceId: anchor.occurrence_id,
    sourceVersion: anchor.source_version,
    before: 0,
    after: 0,
  });
  expect(context.data.messages.length).toBeGreaterThan(0);
  await expect(
    getSessionContext("other", {
      occurrenceId: anchor.occurrence_id,
      sourceVersion: anchor.source_version,
      before: 0,
      after: 0,
    }),
  ).rejects.toThrow("CONTEXT_UNAVAILABLE");
  const state = await sql.get("SELECT * FROM search_index_state WHERE project_id='p'");
  expect(state).toMatchObject({ coverage: "limited" });
  expect(
    await sql.get("SELECT COUNT(*) AS n FROM search_dirty WHERE source_id='bad'"),
  ).toMatchObject({ n: 1 });
});
