import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readSource } from "../session-search/indexer";
import { encodeIoRow, IO_MAX_BYTES, initializeIoSchema, installIoReader } from "./io-compression";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>();
  return { ...actual, deflateSync: vi.fn(actual.deflateSync) };
});

function file(name: string) {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  return join(dirname(base), `${name}.db`);
}

it("codec 阈值、无收益、超限、空串、旧魔法字符串和原始 JSON 字节", () => {
  const db = new Database(file("codec"));
  installIoReader(db);
  const decode = db.prepare("SELECT perifuse_io(?,?,?) AS text");
  try {
    for (const input of [
      null,
      "",
      "null",
      '""',
      "PFIO\u0001",
      "x".repeat(1023),
      randomBytes(2048).toString("latin1"),
      "x".repeat(IO_MAX_BYTES + 1),
    ]) {
      const row = encodeIoRow("traces", { input }, true);
      expect(decode.get(row.input, row.input_codec, row.input_raw_size)).toEqual({ text: input });
      if (input === null || input.length < 1024 || input.length > IO_MAX_BYTES)
        expect(row.input_codec).toBe(0);
    }
    const input = ' { "duplicate": 1, "duplicate": 2, "n": 1.000, "text": "中文" } \n'.repeat(80);
    const row = encodeIoRow("traces", { input }, true);
    expect(row.input_codec).toBe(1);
    expect(decode.get(row.input, row.input_codec, row.input_raw_size)).toEqual({ text: input });
    expect(encodeIoRow("traces", { input }, false).input).toBe(input);
    expect(encodeIoRow("traces", {}, true)).toEqual({});
    expect(() => encodeIoRow("traces", { input: "\ud800" }, true)).toThrow("IO_TEXT_INVALID_UTF16");
    expect(() => encodeIoRow("traces", { input: 0 }, true)).toThrow("IO_TEXT_REQUIRED");
    const noise = randomBytes(1024).toString("base64").slice(0, 1024);
    // 接近阈值的不可压缩 ASCII，收益不足（含元数据成本）则保持 TEXT。
    const noiseRow = encodeIoRow("traces", { input: noise }, true);
    expect(decode.get(noiseRow.input, noiseRow.input_codec, noiseRow.input_raw_size)).toEqual({
      text: noise,
    });
  } finally {
    db.close();
  }
});

it("显式版本、长度、损坏、尾随数据和解压硬上限", () => {
  const db = new Database(file("corruption"));
  installIoReader(db);
  const decode = db.prepare("SELECT perifuse_io(?,?,?)");
  const packed = deflateSync(Buffer.from("x".repeat(2000)));
  try {
    for (const [value, codec, size, error] of [
      [packed, 9, 2000, "VERSION"],
      [packed, 1, -1, "INVALID"],
      [packed, 1, IO_MAX_BYTES + 1, "LIMIT"],
      [packed, 1, 1000, "CORRUPT"],
      [packed, 1, 2001, "CORRUPT"],
      [Buffer.from("bad"), 1, 2000, "CORRUPT"],
      [Buffer.concat([packed, Buffer.from("extra")]), 1, 2000, "CORRUPT"],
      [packed, 0, null, "INVALID"],
      ["text", 0, 99, "LENGTH"],
    ])
      expect(() => decode.get(value, codec, size)).toThrow(`IO_COMPRESSION_${error}`);
  } finally {
    db.close();
  }
});

it("旧 TEXT 增量 schema 幂等且无回填", () => {
  const db = new Database(file("migration"));
  try {
    db.exec(
      "CREATE TABLE traces(input TEXT,output TEXT); CREATE TABLE observations(input TEXT,output TEXT)",
    );
    db.prepare("INSERT INTO traces VALUES(?,?)").run("PFIO\u0001", "");
    initializeIoSchema(db);
    initializeIoSchema(db);
    installIoReader(db);
    expect(db.prepare("SELECT * FROM traces").get()).toEqual({
      input: "PFIO\u0001",
      output: "",
      input_codec: 0,
      output_codec: 0,
      input_raw_size: null,
      output_raw_size: null,
    });
    expect(db.prepare("SELECT * FROM perifuse_read_traces").get()).toEqual({
      input: "PFIO\u0001",
      output: "",
    });
  } finally {
    db.close();
  }
});

it.each(["0", "1"])("显式视图双读与 patch/merge 原子更新 workers=%s", async (workers) => {
  process.env.PERIFUSE_IO_COMPRESSION_WRITE = "on";
  process.env.PERIFUSE_READ_WORKERS = workers;
  const path = file(`updates-${workers}`);
  let db = new SQLiteTelemetryAdapter(path);
  const input = JSON.stringify({ text: "中文\u0000".repeat(1000) });
  const read = () =>
    db.query({
      query: "SELECT input,output FROM perifuse_read_traces WHERE project_id='p' AND id='t'",
    });
  try {
    await db.insert({
      table: "traces",
      records: [{ project_id: "p", id: "t", input, output: "", timestamp: "2026-01-01" }],
    });
    expect(
      db.getDatabase().prepare("SELECT typeof(input) kind,input_codec FROM traces").get(),
    ).toEqual({ kind: "blob", input_codec: 1 });
    expect(await read()).toEqual([{ input, output: "" }]);
    expect(
      readSource(db.getDatabase(), { projectId: "p", id: "t", kind: "trace", revision: 1 })?.input,
    ).toBe(input);
    expect(
      await db.query({
        query:
          "SELECT substr(input,1,9) preview,json_extract(input,'$.text') text FROM perifuse_read_traces",
      }),
    ).toEqual([{ preview: input.slice(0, 9), text: "中文\u0000".repeat(1000) }]);
    await db.insert({
      table: "traces",
      records: [{ project_id: "p", id: "t", name: "patch" }],
      updateColumns: [["name"]],
    });
    expect(await read()).toEqual([{ input, output: "" }]);
    await db.mergeInsert({
      table: "traces",
      records: [{ project_id: "p", id: "t", input: null, output: input }],
    });
    expect(await read()).toEqual([{ input, output: input }]);
    await db.close();
    process.env.PERIFUSE_IO_COMPRESSION_WRITE = "off";
    db = new SQLiteTelemetryAdapter(path);
    expect(await read()).toEqual([{ input, output: input }]);
    await db.insert({
      table: "traces",
      records: [{ project_id: "p", id: "t", input: "" }],
      updateColumns: [["input"]],
    });
    expect(await read()).toEqual([{ input: "", output: input }]);
    expect(db.getDatabase().prepare("SELECT input_codec,input_raw_size FROM traces").get()).toEqual(
      { input_codec: 0, input_raw_size: 0 },
    );
    await db.mergeInsert({
      table: "traces",
      records: [{ project_id: "p", id: "t", output: "plain" }],
    });
    expect(await read()).toEqual([{ input: "", output: "plain" }]);
    db.getDatabase().exec("UPDATE traces SET input_codec=9");
    await expect(read()).rejects.toThrow("IO_COMPRESSION_VERSION");
  } finally {
    await db.close();
    process.env.PERIFUSE_IO_COMPRESSION_WRITE = "off";
    process.env.PERIFUSE_READ_WORKERS = "0";
  }
});

it("压缩字段版本、条件继承、跨项目及失败回滚", async () => {
  process.env.PERIFUSE_IO_COMPRESSION_WRITE = "on";
  const db = new SQLiteTelemetryAdapter(file("atomic"));
  const sql = db.getDatabase();
  const input = "exact text \n".repeat(200);
  const patch = (id: string, input: string | null, eventId: string, time: string) =>
    db.insert({
      table: "traces",
      records: [{ project_id: "p", id, input, event_ts: time, updated_at: time }],
      updateColumns: [["input"]],
      eventIds: [eventId],
    });
  try {
    await patch("t", input, "b", "2026-02-01");
    const before = sql
      .prepare("SELECT input,input_codec,input_raw_size FROM traces WHERE id='t'")
      .get();
    await patch("t", "late", "a", "2026-01-01");
    expect(
      sql.prepare("SELECT input,input_codec,input_raw_size FROM traces WHERE id='t'").get(),
    ).toEqual(before);
    await db.insert({ table: "traces", records: [{ project_id: "q", id: "t", input: "other" }] });
    expect(
      sql.prepare("SELECT input FROM perifuse_read_traces WHERE project_id='q'").get(),
    ).toEqual({ input: "other" });
    const versions = sql.prepare("SELECT * FROM ingestion_field_versions").all();
    sql.exec(
      "CREATE TRIGGER fail_codec AFTER UPDATE ON traces BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    await expect(patch("t", "failed", "c", "2026-03-01")).rejects.toThrow();
    expect(
      sql
        .prepare(
          "SELECT input,input_codec,input_raw_size FROM traces WHERE project_id='p' AND id='t'",
        )
        .get(),
    ).toEqual(before);
    expect(sql.prepare("SELECT * FROM ingestion_field_versions").all()).toEqual(versions);
    sql.exec("DROP TRIGGER fail_codec");
    for (const id of ["t", "empty"]) {
      if (id === "empty") await patch(id, "", "a", "2026-01-01");
      await db.insert({
        table: "traces",
        records: [{ project_id: "p", id, input: "inherited".repeat(200) }],
        updateColumns: [[]],
        inheritColumns: [["input"]],
      });
    }
    expect(
      sql.prepare("SELECT input FROM perifuse_read_traces WHERE project_id='p' AND id='t'").get(),
    ).toEqual({ input });
    expect(
      sql.prepare("SELECT input,input_codec FROM traces WHERE id='empty'").get(),
    ).toMatchObject({ input_codec: 0 });
    expect(sql.prepare("SELECT input FROM perifuse_read_traces WHERE id='empty'").get()).toEqual({
      input: "",
    });
    await patch("t", null, "d", "2026-04-01");
    expect(
      sql
        .prepare(
          "SELECT input,input_codec,input_raw_size FROM traces WHERE project_id='p' AND id='t'",
        )
        .get(),
    ).toEqual({ input: null, input_codec: 0, input_raw_size: 0 });
  } finally {
    await db.close();
    process.env.PERIFUSE_IO_COMPRESSION_WRITE = "off";
  }
});

it("压缩无收益时保留精确 TEXT，不压 usage/cost", () => {
  const input = "字节不变".repeat(400);
  vi.mocked(deflateSync).mockReturnValueOnce(Buffer.alloc(Buffer.byteLength(input)));
  expect(
    encodeIoRow("observations", { input, usage_details: input, cost_details: input }, true),
  ).toEqual({
    input,
    input_codec: 0,
    input_raw_size: Buffer.byteLength(input),
    usage_details: input,
    cost_details: input,
  });
});
