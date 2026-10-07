import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { openLocalDatabase } from "../../db/local";
import { rejectSql } from "../../db/testing";
import { readSource } from "../session-search/indexer";
import { decodeIoRow, encodeIoRow, IO_MAX_BYTES, initializeIoSchema } from "./io-compression";
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

it("preserves exact text, thresholds, nulls, UTF-8 and repeated JSON keys", () => {
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
    expect(decodeIoRow(row)).toEqual({ input });
    if (input === null || input.length < 1024 || input.length > IO_MAX_BYTES)
      expect(row.input_codec).toBe(0);
  }
  const input = ' { "duplicate": 1, "duplicate": 2, "n": 1.000, "text": "中文" } \n'.repeat(80);
  const row = encodeIoRow("traces", { input }, true);
  expect(row.input_codec).toBe(1);
  expect(decodeIoRow(row)).toEqual({ input });
  expect(encodeIoRow("traces", { input }, false).input).toBe(input);
  expect(encodeIoRow("traces", {}, true)).toEqual({});
  expect(() => encodeIoRow("traces", { input: "\ud800" }, true)).toThrow("IO_TEXT_INVALID_UTF16");
  expect(() => encodeIoRow("traces", { input: 0 }, true)).toThrow("IO_TEXT_REQUIRED");
});

it("rejects unknown codecs, invalid lengths, corrupt streams and decompression bombs", () => {
  const packed = deflateSync(Buffer.from("x".repeat(2000)));
  for (const [input, input_codec, input_raw_size, error] of [
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
    expect(() => decodeIoRow({ input, input_codec, input_raw_size })).toThrow(
      `IO_COMPRESSION_${error}`,
    );
});

it("initializes codec columns idempotently without rewriting text", async () => {
  const db = await openLocalDatabase(file("codec-schema"));
  try {
    await db.exec(
      "CREATE TABLE traces(input TEXT,output TEXT); CREATE TABLE observations(input TEXT,output TEXT)",
    );
    await db.run("INSERT INTO traces VALUES(?,?)", "PFIO\u0001", "");
    await initializeIoSchema(db);
    await initializeIoSchema(db);
    expect(decodeIoRow(await db.get("SELECT * FROM traces"))).toEqual({
      input: "PFIO\u0001",
      output: "",
    });
  } finally {
    await db.close();
  }
});

it.each(["0", "1"])(
  "decodes main and worker reads with PERIFUSE_READ_WORKERS=%s",
  async (workers) => {
    vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
    vi.stubEnv("PERIFUSE_READ_WORKERS", workers);
    const adapter = new SQLiteTelemetryAdapter(file(`worker-codec-${workers}`));
    await adapter.initialize();
    const input = "精确正文 \n".repeat(300);
    try {
      await adapter.insert({
        table: "traces",
        records: [{ project_id: "p", id: "t", input, output: input }],
      });
      const read = () =>
        adapter.query({
          query:
            "SELECT input,input_codec,input_raw_size,output,output_codec,output_raw_size FROM traces",
        });
      expect(await read()).toEqual([{ input, output: input }]);
      expect(
        await readSource(adapter.getDatabase(), {
          projectId: "p",
          kind: "trace",
          id: "t",
          revision: 1,
        }),
      ).toMatchObject({ input, output: input });
      await adapter.insert({
        table: "traces",
        records: [{ project_id: "p", id: "t", input: "" }],
        updateColumns: [["input"]],
      });
      expect(await read()).toEqual([{ input: "", output: input }]);
      await adapter.mergeInsert({
        table: "traces",
        records: [{ project_id: "p", id: "t", output: "plain" }],
      });
      expect(await read()).toEqual([{ input: "", output: "plain" }]);
      await adapter.getDatabase().run("UPDATE traces SET input_codec=9");
      await expect(read()).rejects.toThrow("IO_COMPRESSION_VERSION");
    } finally {
      await adapter.close();
      vi.unstubAllEnvs();
    }
  },
);

it("keeps codec versions and inherited bodies atomic and project isolated", async () => {
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
  const adapter = new SQLiteTelemetryAdapter(file("atomic-codec"));
  await adapter.initialize();
  const input = "exact text \n".repeat(200);
  const patch = (id: string, body: string | null, eventId: string, time: string) =>
    adapter.insert({
      table: "traces",
      records: [{ project_id: "p", id, input: body, event_ts: time, updated_at: time }],
      updateColumns: [["input"]],
      eventIds: [eventId],
    });
  try {
    await patch("t", input, "b", "2026-02-01");
    const db = adapter.getDatabase();
    const before = await db.get("SELECT * FROM traces WHERE project_id='p' AND id='t'");
    await patch("t", "late", "a", "2026-01-01");
    expect(await db.get("SELECT * FROM traces WHERE project_id='p' AND id='t'")).toEqual(before);
    await adapter.insert({
      table: "traces",
      records: [{ project_id: "q", id: "t", input: "other" }],
    });
    const versions = await db.all("SELECT * FROM ingestion_field_versions");
    const fault = rejectSql(db, /INSERT INTO traces/i, vi);
    try {
      await expect(patch("t", "failed", "c", "2026-03-01")).rejects.toThrow();
    } finally {
      fault.mockRestore();
    }
    expect(await db.get("SELECT * FROM traces WHERE project_id='p' AND id='t'")).toEqual(before);
    expect(await db.all("SELECT * FROM ingestion_field_versions")).toEqual(versions);
    for (const id of ["t", "empty"]) {
      if (id === "empty") await patch(id, "", "a", "2026-01-01");
      await adapter.insert({
        table: "traces",
        records: [{ project_id: "p", id, input: "inherited".repeat(200) }],
        updateColumns: [[]],
        inheritColumns: [["input"]],
      });
    }
    expect(
      (await adapter.query({ query: "SELECT * FROM traces WHERE project_id='p' AND id='t'" }))[0]
        .input,
    ).toBe(input);
    expect(
      (await adapter.query({ query: "SELECT * FROM traces WHERE project_id='q'" }))[0].input,
    ).toBe("other");
    expect((await adapter.query({ query: "SELECT * FROM traces WHERE id='empty'" }))[0].input).toBe(
      "",
    );
    await patch("t", null, "d", "2026-04-01");
    expect(
      await db.get(
        "SELECT input,input_codec,input_raw_size FROM traces WHERE project_id='p' AND id='t'",
      ),
    ).toEqual({ input: null, input_codec: 0, input_raw_size: 0 });
  } finally {
    await adapter.close();
    vi.unstubAllEnvs();
  }
});

it("keeps unprofitable compression as text and never compresses usage or cost", () => {
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
