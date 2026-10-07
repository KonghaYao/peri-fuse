import { dirname, join } from "node:path";
import { rejectSql } from "@peri-fuse/shared/src/db/testing";
import type { Context, Next } from "hono";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "../../../shared/src/server/adapters/sqlite-telemetry-adapter";

vi.mock("../auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    c.set("auth", {
      validKey: true,
      scope: { projectId: "synthetic", accessLevel: "project", publicKey: "synthetic" },
    });
    await next();
  },
}));
vi.mock("../../../shared/src/server/adapters", async (original) => ({
  ...(await original<typeof import("../../../shared/src/server/adapters")>()),
  getTelemetryDB: () => db,
}));
vi.mock("@peri-fuse/shared", async () => import("../../../shared/src/index"));
vi.mock("@peri-fuse/shared/src/server", async () => {
  const { processEventBatchLite } = await import(
    "../../../shared/src/server/ingestion/processEventBatchLite"
  );
  const { OtelIngestionProcessor } = await import(
    "../../../shared/src/server/otel/OtelIngestionProcessor"
  );
  return {
    processEventBatch: processEventBatchLite,
    OtelIngestionProcessor,
    createIngestionAttribution: () => ({
      ingestionApiKey: "synthetic",
      ingestionSdkName: "test",
      ingestionSdkVersion: "1",
    }),
    getLangfuseHeaderValue: () => undefined,
    markProjectAsOtelUser: async () => {},
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

import { $root } from "../otel-proto/root";
import ingestion from "../routes/ingestion";
import otel from "../routes/otel";

if (!process.env.LANGFUSE_SQLITE_DB_PATH?.includes("peri-ingestion-test-"))
  throw new Error("必须通过隔离入口运行");
vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
const db = new SQLiteTelemetryAdapter(
  join(dirname(process.env.LANGFUSE_SQLITE_DB_PATH), "http.db"),
);
await db.initialize();
const sql = db.getDatabase();
beforeEach(async () => {
  vi.restoreAllMocks();
  await sql.exec(
    "DELETE FROM observations; DELETE FROM traces; DELETE FROM ingestion_field_versions",
  );
});
afterAll(async () => await db.close());
const fail = () => rejectSql(sql, /INSERT(?: OR REPLACE)? INTO observations/i, vi);

it("REST 207 准确区分提交、校验失败与可重试失败", async () => {
  const batch = [
    { id: "trace", timestamp: "2026-01-01T00:00:00Z", type: "trace-create", body: { id: "t" } },
    {
      id: "obs",
      timestamp: "2026-01-01T00:00:00Z",
      type: "generation-create",
      body: { id: "o", traceId: "t" },
    },
    { id: "invalid" },
  ];
  const send = () =>
    ingestion.request("/api/public/ingestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batch }),
    });
  fail();
  const failed = await send();
  expect(failed.status).toBe(207);
  const result = await failed.json();
  expect(result.successes).toEqual([{ id: "trace", status: 201 }]);
  expect(result.errors.map((e: { status: number }) => e.status)).toEqual([400, 500]);
  vi.restoreAllMocks();
  expect((await (await send()).json()).successes).toHaveLength(2);
  expect(await sql.get("SELECT COUNT(*) AS n FROM observations")).toEqual({ n: 1 });
});

it.each(["application/json", "application/x-protobuf"])(
  "OTLP %s 真实转换、SQLite 提交失败及重试",
  async (contentType) => {
    const span = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      name: "synthetic",
      kind: 1,
      startTimeUnixNano: "1753456800000000000",
      endTimeUnixNano: "1753456801000000000",
      attributes: [
        { key: "langfuse.observation.type", value: { stringValue: "generation" } },
        {
          key: "langfuse.observation.input",
          value: { stringValue: JSON.stringify("OTLP 中文 ".repeat(2000)) },
        },
      ],
      status: { code: 1 },
    };
    const request = {
      resourceSpans: [
        { resource: { attributes: [] }, scopeSpans: [{ scope: { name: "test" }, spans: [span] }] },
      ],
    };
    const proto = $root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    const body =
      contentType === "application/json"
        ? JSON.stringify(request)
        : Buffer.from(
            proto
              .encode(
                proto.fromObject({
                  resourceSpans: [
                    {
                      resource: { attributes: [] },
                      scopeSpans: [
                        {
                          scope: { name: "test" },
                          spans: [
                            {
                              ...span,
                              traceId: Buffer.from(span.traceId, "hex"),
                              spanId: Buffer.from(span.spanId, "hex"),
                            },
                          ],
                        },
                      ],
                    },
                  ],
                }),
              )
              .finish(),
          );
    const send = () =>
      otel.request("/api/public/otel/v1/traces", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    fail();
    expect((await send()).status).toBe(503);
    expect(await sql.get("SELECT COUNT(*) AS n FROM observations")).toEqual({ n: 0 });
    vi.restoreAllMocks();
    const success = await send();
    expect(success.status).toBe(200);
    if (contentType === "application/x-protobuf") {
      expect(success.headers.get("content-type")).toBe("application/x-protobuf");
      expect((await success.arrayBuffer()).byteLength).toBe(0);
    } else {
      expect(await success.json()).toEqual({});
    }
    expect((await send()).status).toBe(200);
    expect(await sql.get("SELECT COUNT(*) AS n FROM observations")).toEqual({ n: 1 });
    expect(await sql.get("SELECT input_codec FROM observations")).toEqual({ input_codec: 1 });
    const [decoded] = await db.query<{ input: string }>({
      query: "SELECT input,input_codec,input_raw_size FROM observations",
    });
    expect(JSON.parse(decoded.input)).toBe("OTLP 中文 ".repeat(2000));
  },
);
