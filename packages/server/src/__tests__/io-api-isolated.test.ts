import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Context, Next } from "hono";
import { Langfuse } from "langfuse";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "../../../shared/src/server/adapters/sqlite-telemetry-adapter";

vi.mock("../auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    c.set("auth", { validKey: true, scope: { projectId: "p", accessLevel: "project" } });
    await next();
  },
}));
vi.mock("../response-cache", () => ({
  responseCache: () => async (_c: Context, next: Next) => next(),
}));
vi.mock("../../../shared/src/server/adapters", async (original) => ({
  ...(await original<typeof import("../../../shared/src/server/adapters")>()),
  ...(await import("../../../shared/src/server/adapters/trace-metrics-sql")),
  getTelemetryDB: () => db,
}));
vi.mock(
  "@peri-fuse/shared/src/server/adapters",
  async () => import("../../../shared/src/server/adapters"),
);
vi.mock("@peri-fuse/shared", async () => import("../../../shared/src/index"));
vi.mock("@peri-fuse/shared/src/server", async () => import("../../../shared/src/server"));
vi.mock("@peri-fuse/shared/src/db", async () => import("../../../shared/src/db"));
vi.mock(
  "@peri-fuse/shared/src/db/schema/index.js",
  async () => import("../../../shared/src/db/schema/index"),
);

import ingestion from "../routes/ingestion";
import observations from "../routes/observations";
import sessions from "../routes/session-detail";
import traces from "../routes/traces";
import { buildObservationsV2Select } from "../shaping/observations-v2";

let db: SQLiteTelemetryAdapter;
const text = "中文𝄞 无损正文 ".repeat(3000);
beforeAll(async () => {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
  vi.stubEnv("PERIFUSE_READ_WORKERS", "1");
  db = new SQLiteTelemetryAdapter(join(dirname(base), "api-compressed.db"));
  await db.initialize();
  for (const project_id of ["p", "other"]) {
    await db.insert({
      table: "traces",
      records: [
        {
          id: "t",
          project_id,
          session_id: "s",
          timestamp: "2026-01-01 00:00:00",
          input: JSON.stringify(text),
          output: "",
        },
      ],
    });
    await db.insert({
      table: "observations",
      records: [
        {
          id: "o",
          project_id,
          trace_id: "t",
          start_time: "2026-01-01 00:00:00",
          input: JSON.stringify(text),
          output: "",
        },
      ],
    });
  }
});
afterAll(async () => {
  await db?.close();
  vi.unstubAllEnvs();
});

it("公开 trace 完整详情、列表、preview 与 session 批量正文", async () => {
  const detail = await traces.request("/api/public/traces/t?fields=core,io");
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ input: text, output: "" });
  const list = await traces.request("/api/public/traces?fields=core,io");
  expect(list.status).toBe(200);
  expect((await list.json()).data).toMatchObject([{ id: "t", input: text, output: "" }]);
  const full = await traces.request("/api/public/traces/metrics?traceIds=t&fields=io");
  expect((await full.json())[0]).toMatchObject({ input: text, output: "" });
  const preview = await traces.request("/api/public/traces/metrics?traceIds=t&fields=io_preview");
  const result = (await preview.json())[0];
  expect(result.input).toBe(Array.from(JSON.stringify(text)).slice(0, 500).join(""));
  expect(Buffer.byteLength(result.input)).toBeLessThanOrEqual(2000);
  const session = await sessions.request("/api/public/sessions/s?includeObservations=false");
  expect(session.status).toBe(200);
  expect((await session.json()).traces).toMatchObject([{ id: "t", input: text, output: "" }]);
  const query = buildObservationsV2Select(new Set(["io"]));
  expect(
    await db.query({ query: `${query} WHERE o.project_id=@p`, params: { p: "p" } }),
  ).toMatchObject([{ id: "o", input: JSON.stringify(text), output: "" }]);
});

it.each([
  "input_codec=99",
  "input_codec=1, input=x'000102', input_raw_size=2000",
  "input_codec=1, input_raw_size=33554433",
])("损坏正文在 API 显式失败；不请求 IO 的路径不解压：%s", async (damage) => {
  await db.getDatabase().run(`UPDATE traces SET ${damage} WHERE project_id='p'`);
  await db.getDatabase().run(`UPDATE observations SET ${damage} WHERE project_id='p'`);
  for (const url of [
    "/api/public/traces/t?fields=core",
    "/api/public/traces?fields=core",
    "/api/public/traces/metrics?traceIds=t&fields=metrics",
  ]) {
    expect((await traces.request(url)).status).toBe(200);
  }
  expect((await sessions.request("/api/public/sessions/s?includeIo=false")).status).toBe(200);
  for (const url of [
    "/api/public/traces/t?fields=core,io",
    "/api/public/traces?fields=core,io",
    "/api/public/traces/metrics?traceIds=t&fields=io_preview",
  ]) {
    expect((await traces.request(url)).status).toBe(500);
  }
  expect((await sessions.request("/api/public/sessions/s")).status).toBe(500);
  expect((await observations.request("/api/public/observations?fields=summary")).status).toBe(200);
  expect((await observations.request("/api/public/observations")).status).toBe(500);
  const query = buildObservationsV2Select(new Set(["basic"]));
  expect(await db.query({ query: `${query} WHERE o.project_id='p'` })).toHaveLength(1);
});

it("本地真实 Langfuse SDK 序列化、摄入与公开 API 往返", async () => {
  const sdk = new Langfuse({
    publicKey: randomBytes(16).toString("hex"),
    secretKey: randomBytes(32).toString("hex"),
    persistence: "memory",
    flushAt: 100,
    flushInterval: 60_000,
  });
  // 只替换传输到本地 Hono，不 mock SDK 队列、事件编码或摄入逻辑。
  const transport = vi.spyOn(sdk, "fetch").mockImplementation(async (_url, options) => {
    const response = await ingestion.request("/api/public/ingestion", {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    return { status: response.status, json: () => response.json(), text: () => response.text() };
  });
  try {
    sdk.trace({ id: "sdk", input: { messages: [{ role: "user", content: text }] }, output: "" });
    await sdk.flushAsync();
    expect(transport).toHaveBeenCalled();
    expect(
      await db
        .getDatabase()
        .get("SELECT input_codec FROM traces WHERE project_id='p' AND id='sdk'"),
    ).toEqual({ input_codec: 1 });
    const response = await traces.request("/api/public/traces/sdk?fields=core,io");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      input: { messages: [{ role: "user", content: text }] },
      output: "",
    });
  } finally {
    await sdk.shutdownAsync();
    transport.mockRestore();
  }
});
