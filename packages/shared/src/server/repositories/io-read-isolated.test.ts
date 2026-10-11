import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { openLocalDatabase, withLocalTransaction } from "../../db/local";
import { decodeIoRow } from "../adapters/io-compression";
import { SQLiteTelemetryAdapter } from "../adapters/sqlite-telemetry-adapter";
import { contentHash } from "../io-cas/hash";
import { encodeManifest, type ManifestToken } from "../io-cas/manifest";
import {
  buildCasReaderSource,
  buildIoRowsGuardSource,
  buildIoRowWeigherSource,
  IO_CAS_READ_BUDGET,
  weighIoRow,
} from "../io-cas/reader-source";
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

it("search 按原正文体积标记 limited，损坏源隔离且报告错误", async () => {
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
  expect(state).toMatchObject({ coverage: "limited", pending: 0 });
  expect((state as { last_error: string }).last_error).toContain(
    "permanent: IO_COMPRESSION_VERSION",
  );
  expect(
    await sql.get("SELECT COUNT(*) AS n FROM search_dirty WHERE source_id='bad'"),
  ).toMatchObject({ n: 0 });
});

it("codec 2（CAS）在 NO-GO 引擎上按门禁拒绝，不读取正文的路径不受影响", async () => {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  const file = join(dirname(base), "cas-no-go.db");
  db = new SQLiteTelemetryAdapter(file);
  await db.initialize();
  await db.insert({
    table: "traces",
    records: [
      { id: "t", project_id: "p", timestamp: "2026-01-01 00:00:00", input: "plain", output: "" },
    ],
  });
  await db.insert({
    table: "observations",
    records: [
      {
        id: "o",
        trace_id: "t",
        project_id: "p",
        start_time: "2026-01-01 00:00:00",
        input: "plain",
        output: "",
      },
    ],
  });
  // 本 workstream 没有写开关，codec 2 行由直写模拟：NO-GO 引擎必须显式拒绝，
  // 绝不把未装配的 manifest BLOB 交给上层 String()。
  for (const table of ["traces", "observations"])
    await db
      .getDatabase()
      .run(
        `UPDATE ${table} SET input=x'000102', input_codec=2, input_raw_size=2 WHERE project_id='p'`,
      );
  await expect(
    db.query({ query: "SELECT input,input_codec,input_raw_size FROM traces WHERE project_id='p'" }),
  ).rejects.toThrow("verified read snapshot");
  await expect(liteGetTraceById("p", "t")).rejects.toThrow("verified read snapshot");
  expect((await liteGetTraceById("p", "t", true))?.input).toBeNull();
  expect(await liteGetTracesTable({ projectId: "p", includeIO: false })).toHaveLength(1);
  await db.close();
  // 再次打开同一文件：W1 的启动门禁直接拒绝"无法安全读取的存量 codec 2"。
  const reopened = new SQLiteTelemetryAdapter(file);
  await expect(reopened.initialize()).rejects.toThrow("verified read snapshot");
  await reopened.close();
});

it("D-3：缺 codec 投影与未 hydrate 的 codec 2 都是显式内部错误", async () => {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
  vi.stubEnv("PERIFUSE_READ_WORKERS", "0");
  db = new SQLiteTelemetryAdapter(join(dirname(base), "cas-projection.db"));
  await db.initialize();
  await db.insert({
    table: "traces",
    records: [
      {
        id: "t",
        project_id: "p",
        timestamp: "2026-01-01 00:00:00",
        input: "无损 Unicode 中文𝄞 ".repeat(2000),
        output: "",
      },
    ],
  });
  expect(
    (await db.getDatabase().get("SELECT input_codec FROM traces")) as { input_codec: number },
  ).toEqual({ input_codec: 1 });
  // decodeIoRow：codec 2 明确报"需要 CAS 解析器"，codec 99 仍是版本错误。
  expect(() => decodeIoRow({ input: Buffer.from([1, 2, 3]), input_raw_size: 3 })).toThrow(
    "IO_CAS_INVALID",
  );
  expect(() =>
    decodeIoRow({ input: Buffer.from([1, 2, 3]), input_codec: 2, input_raw_size: 3 }),
  ).toThrow("IO_CAS_PARSER_REQUIRED");
  expect(() => decodeIoRow({ input: "text", input_codec: 99 })).toThrow("IO_COMPRESSION_VERSION");
  // 投影漏了 codec 列时读层直接拒绝（编码 BLOB 不允许离开读层）。
  await expect(
    db.query({ query: "SELECT input FROM traces WHERE project_id='p'" }),
  ).rejects.toThrow("IO_CAS_INVALID");
  // ioRead=none 只是"不选 IO"的声明，不能用来绕过守卫。
  await db
    .getDatabase()
    .run("UPDATE traces SET input=x'000102', input_codec=2 WHERE project_id='p'");
  await expect(
    db.query({
      query: "SELECT id,input,input_codec,input_raw_size FROM traces WHERE project_id='p'",
      ioRead: "none",
    }),
  ).rejects.toThrow("verified read snapshot");
});

it("源码工厂：注入源码在真实事务内 hydrate，且不引用模块闭包", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-cas-source-"));
  const database = await openLocalDatabase(join(directory, "cas.db"));
  try {
    await database.exec(
      `CREATE TABLE io_cas_chunks (
        project_id text NOT NULL,
        content_hash blob NOT NULL,
        codec integer NOT NULL,
        raw_size integer NOT NULL,
        payload blob NOT NULL,
        mark_epoch integer DEFAULT 0 NOT NULL,
        CONSTRAINT io_cas_chunks_pk PRIMARY KEY(project_id, content_hash)
      )`,
    );
    const messages = [
      { role: "user", content: "你好🌍" },
      { role: "assistant", content: "ok" },
    ];
    const encoded = messages.map((message) => Buffer.from(JSON.stringify(message), "utf8"));
    const text = `[${messages.map((message) => JSON.stringify(message)).join(",")}]`;
    for (const bytes of encoded)
      await database.run(
        "INSERT INTO io_cas_chunks(project_id,content_hash,codec,raw_size,payload) VALUES(?,?,?,?,?)",
        "p",
        contentHash(bytes),
        1,
        bytes.byteLength,
        deflateSync(bytes),
      );
    const tokens: ManifestToken[] = [{ tag: "literal", bytes: Buffer.from("[", "utf8") }];
    encoded.forEach((bytes, index) => {
      if (index > 0) tokens.push({ tag: "literal", bytes: Buffer.from(",", "utf8") });
      tokens.push({ tag: "ref", hash: contentHash(bytes) });
    });
    tokens.push({ tag: "literal", bytes: Buffer.from("]", "utf8") });
    const manifest = encodeManifest(tokens, Buffer.from(text, "utf8"));

    // 与 worker 相同的组装方式：源码 + require 注入，然后执行。
    const source = [
      buildCasReaderSource(),
      buildIoRowsGuardSource("() => { throw new Error('NO_SNAPSHOT'); }"),
      buildIoRowWeigherSource(),
    ].join("\n");
    const injected = new Function(
      "require",
      `${source}\nreturn { hydrateIoRows, guardIoRows, weighIoRow };`,
    )(createRequire(import.meta.url)) as {
      hydrateIoRows: typeof import("../io-cas/read").hydrateIoRows;
      guardIoRows: (rows: readonly Record<string, unknown>[]) => void;
      weighIoRow: (row: Record<string, unknown>) => number;
    };

    const rows: Record<string, unknown>[] = [
      {
        id: "o",
        project_id: "p",
        input: manifest,
        input_codec: 2,
        input_raw_size: Buffer.byteLength(text, "utf8"),
      },
    ];
    const hydrated = await withLocalTransaction(database, (tx) =>
      injected.hydrateIoRows(tx, rows, IO_CAS_READ_BUDGET),
    );
    expect(hydrated[0].input).toBe(text);
    expect(hydrated[0].input_codec).toBeUndefined();
    expect(hydrated[0].input_raw_size).toBeUndefined();
    // 后续 decodeIoRow 看到已装配的字符串，按无 codec 行原样通过。
    expect(() => decodeIoRow(hydrated[0])).not.toThrow();

    // 守卫与主线程共用同一实现：未 hydrate 的 codec 2 与缺 codec 的 BLOB 都被拒绝。
    expect(() => injected.guardIoRows([{ input: Buffer.alloc(4), input_codec: 2 }])).toThrow(
      "NO_SNAPSHOT",
    );
    expect(() => injected.guardIoRows([{ input: Buffer.alloc(4) }])).toThrow("IO_CAS_INVALID");
    expect(() => injected.guardIoRows([{ input: "text", input_codec: 0 }])).not.toThrow();
    expect(injected.weighIoRow(hydrated[0])).toBe(weighIoRow(hydrated[0]));
  } finally {
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
