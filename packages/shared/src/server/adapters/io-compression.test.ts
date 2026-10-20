import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { openLocalDatabase } from "../../db/local";
import { rejectSql } from "../../db/testing";
import { readSource } from "../session-search/indexer";
import { refreshIngestionMetrics } from "./ingestion-metrics";
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

it("defaults to compressing new writes when PERIFUSE_IO_COMPRESSION_WRITE is unset", async () => {
  const previous = process.env.PERIFUSE_IO_COMPRESSION_WRITE;
  delete process.env.PERIFUSE_IO_COMPRESSION_WRITE;
  const adapter = new SQLiteTelemetryAdapter(file("default-compression"));
  try {
    await adapter.initialize();
    const input = "default-compression ".repeat(400);
    await adapter.insert({
      table: "traces",
      records: [{ project_id: "p", id: "t", input }],
    });
    const row = await adapter
      .getDatabase()
      .get("SELECT input_codec FROM traces WHERE project_id='p' AND id='t'");
    expect(row).toEqual({ input_codec: 1 });
  } finally {
    await adapter.close();
    if (previous === undefined) delete process.env.PERIFUSE_IO_COMPRESSION_WRITE;
    else process.env.PERIFUSE_IO_COMPRESSION_WRITE = previous;
  }
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

it("appends observations without trace-wide rebuild and rebuilds affected traces on moves", async () => {
  const adapter = new SQLiteTelemetryAdapter(file("incremental-metrics"));
  await adapter.initialize();
  const db = adapter.getDatabase();
  try {
    const forbidRebuild = rejectSql(
      db,
      /DELETE FROM trace_metrics WHERE project_id=@projectId/i,
      vi,
    );
    try {
      for (let index = 0; index < 30; index++) {
        await adapter.insert({
          table: "observations",
          records: [
            {
              project_id: "p",
              id: `o-${index}`,
              trace_id: "t",
              usage_details:
                index === 1
                  ? '{"input":2,"output":1,"input_cached_tokens":1,"input_cache_creation":1}'
                  : '{"input":2}',
              ...(index === 1
                ? {
                    cost_details: '{"input":0.1,"output":0.2}',
                    total_cost: 0.3,
                  }
                : {}),
            },
          ],
        });
      }
      await adapter.insert({
        table: "observations",
        records: [{ project_id: "p", id: "o-0", usage_details: '{"input":5,"cached_tokens":1}' }],
        updateColumns: [["usage_details"]],
      });
      await adapter.insert({
        table: "observations",
        records: [
          {
            project_id: "p",
            id: "o-1",
            usage_details:
              '{"input":2,"output":1,"input_cached_tokens":2,"input_cache_creation":1}',
            cost_details: '{"input":0.4,"output":0.6}',
            total_cost: 1,
          },
        ],
        updateColumns: [["usage_details", "cost_details", "total_cost"]],
      });
    } finally {
      forbidRebuild.mockRestore();
    }
    expect(
      await db.get(
        "SELECT obs_count,input_tokens FROM trace_metrics WHERE project_id='p' AND trace_id='t'",
      ),
    ).toEqual({ obs_count: 30, input_tokens: 63 });
    await adapter.insert({
      table: "observations",
      records: [{ project_id: "q", id: "o-0", trace_id: "t", usage_details: '{"input":7}' }],
    });
    const forbidMoveRebuild = rejectSql(
      db,
      /DELETE FROM trace_metrics WHERE project_id=@projectId/i,
      vi,
    );
    try {
      await adapter.insert({
        table: "observations",
        records: [{ project_id: "p", id: "o-0", trace_id: "moved" }],
        updateColumns: [["trace_id"]],
      });
    } finally {
      forbidMoveRebuild.mockRestore();
    }
    expect(
      await db.all(
        "SELECT project_id,trace_id,obs_count,input_tokens FROM trace_metrics ORDER BY project_id,trace_id",
      ),
    ).toEqual([
      { project_id: "p", trace_id: "moved", obs_count: 1, input_tokens: 5 },
      { project_id: "p", trace_id: "t", obs_count: 29, input_tokens: 58 },
      { project_id: "q", trace_id: "t", obs_count: 1, input_tokens: 7 },
    ]);
    await adapter.insert({
      table: "observations",
      records: [{ project_id: "p", id: "o-0", is_deleted: 1 }],
      updateColumns: [["is_deleted"]],
    });
    expect(
      await db.get("SELECT 1 FROM trace_metrics WHERE project_id='p' AND trace_id='moved'"),
    ).toBeUndefined();
    const optimized = await db.all("SELECT * FROM trace_metrics ORDER BY project_id,trace_id");
    expect(
      optimized.find((metric) => metric.project_id === "p" && metric.trace_id === "t"),
    ).toMatchObject({
      total_cost: 1,
      input_cost: 0.4,
      output_cost: 0.6,
      cached_tokens: 2,
      cache_creation_tokens: 1,
      gross_input_tokens: 61,
    });
    for (const [projectId, traceId] of [
      ["p", "t"],
      ["p", "moved"],
      ["q", "t"],
    ])
      await refreshIngestionMetrics(db, projectId, traceId);
    expect(await db.all("SELECT * FROM trace_metrics ORDER BY project_id,trace_id")).toEqual(
      optimized,
    );
  } finally {
    await adapter.close();
  }
});

it("queues search only for indexed observation fields", async () => {
  const adapter = new SQLiteTelemetryAdapter(file("search-dirty-fields"));
  await adapter.initialize();
  const db = adapter.getDatabase();
  try {
    await adapter.insert({
      table: "observations",
      records: [{ project_id: "p", id: "o", trace_id: "t", name: "first", input: "body" }],
    });
    const revision = () =>
      db.get(
        "SELECT revision FROM search_source_revisions WHERE project_id='p' AND source_kind='observation' AND source_id='o'",
      );
    const first = await revision();
    const firstDay = (await db.get(
      "SELECT revision FROM daily_stats_dirty WHERE project_id='p'",
    )) as { revision: number };
    await adapter.insert({
      table: "observations",
      records: [{ project_id: "p", id: "o", name: "second" }],
      updateColumns: [["name"]],
    });
    expect(await revision()).toEqual(first);
    expect(await db.get("SELECT revision FROM daily_stats_dirty WHERE project_id='p'")).toEqual({
      revision: firstDay.revision + 1,
    });
    const searchablePatch = {
      table: "observations",
      records: [{ project_id: "p", id: "o", output: "new body", event_ts: "2026-01-01" }],
      updateColumns: [["output"]],
      eventIds: ["same-event"],
    };
    await adapter.insert(searchablePatch);
    const changed = await revision();
    const dirtyRevision = await db.get(
      "SELECT revision FROM daily_stats_dirty WHERE project_id='p'",
    );
    expect(changed).not.toEqual(first);
    await adapter.insert(searchablePatch);
    expect(await revision()).toEqual(changed);
    expect(await db.get("SELECT revision FROM daily_stats_dirty WHERE project_id='p'")).toEqual(
      dirtyRevision,
    );
  } finally {
    await adapter.close();
  }
});

it("rebuilds missing legacy metrics and coalesces mixed updates before commit", async () => {
  const adapter = new SQLiteTelemetryAdapter(file("legacy-metrics"));
  await adapter.initialize();
  const db = adapter.getDatabase();
  try {
    await db.run(
      "INSERT INTO observations(project_id,id,trace_id,usage_details) VALUES(?,?,?,?)",
      "p",
      "legacy",
      "t",
      '{"input":3}',
    );
    await adapter.insert({
      table: "observations",
      records: [{ project_id: "p", id: "new", trace_id: "t", usage_details: '{"input":2}' }],
    });
    expect(
      await db.get(
        "SELECT obs_count,input_tokens FROM trace_metrics WHERE project_id='p' AND trace_id='t'",
      ),
    ).toEqual({ obs_count: 2, input_tokens: 5 });
    await adapter.insert({
      table: "observations",
      records: [
        { project_id: "p", id: "new", usage_details: '{"input":4}' },
        { project_id: "p", id: "newest", trace_id: "t", usage_details: '{"input":6}' },
      ],
      updateColumns: [["usage_details"], ["trace_id", "usage_details"]],
    });
    expect(
      await db.get(
        "SELECT obs_count,input_tokens FROM trace_metrics WHERE project_id='p' AND trace_id='t'",
      ),
    ).toEqual({ obs_count: 3, input_tokens: 13 });
    const forbidTraceRebuild = rejectSql(
      db,
      /DELETE FROM trace_metrics WHERE project_id=@projectId/i,
      vi,
    );
    try {
      await adapter.insert({
        table: "traces",
        records: [
          { project_id: "p", id: "t", user_id: "u", session_id: "s", timestamp: "2026-01-01" },
        ],
      });
    } finally {
      forbidTraceRebuild.mockRestore();
    }
    expect(
      await db.get(
        "SELECT user_id,session_id,timestamp FROM trace_metrics WHERE project_id='p' AND trace_id='t'",
      ),
    ).toEqual({ user_id: "u", session_id: "s", timestamp: "2026-01-01" });
  } finally {
    await adapter.close();
  }
});
