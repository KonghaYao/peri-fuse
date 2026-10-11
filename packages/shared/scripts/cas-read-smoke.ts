/**
 * Bun smoke for the CAS read path (W4b).
 *
 * 覆盖三条只有 Bun 轨道能验证的行为：
 *   1. `PERIFUSE_ENGINE=sqlite` 真机读快照：codec 0/1/2 混合结果在 in-process 与
 *      read worker 两种模式下都由同一份 CAS reader source 装配；
 *   2. NO-GO 引擎（Turso local）在真实 Bun 运行时同样按门禁拒绝 codec 2；
 *   3. bundle 产物：esbuild 打包 `sqlite-read-pool.ts` 后，注入的 worker 源码仍可执行，
 *      并且真实 CLI 产物（`packages/cli/dist/server.cjs`）确实内嵌了 CAS reader source。
 *
 * 前置：`packages/shared/dist` 必须存在（`pnpm --filter @perifuse/shared run build`，
 * 隔离测试脚本 `node scripts/test-ingestion-isolated.mjs` 会顺带产出）。
 *
 * Usage:
 *   cd packages/shared
 *   bun run scripts/cas-read-smoke.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

process.env.LANGFUSE_MODE ??= "lite";
process.env.PERIFUSE_ENGINE = "sqlite";
process.env.PERIFUSE_IO_COMPRESSION_WRITE = "on";

const here = dirname(fileURLToPath(import.meta.url));
const sharedRoot = join(here, "..");
const repoRoot = join(sharedRoot, "..", "..");

assert.equal(typeof process.versions.bun, "string", "This smoke requires the Bun runtime");

const { resolveLocalEngine } = await import("../src/db/local");
const { SQLiteTelemetryAdapter } = await import("../src/server/adapters/sqlite-telemetry-adapter");
const { contentHash } = await import("../src/server/io-cas/hash");
const { encodeManifest } = await import("../src/server/io-cas/manifest");
const { processDirty } = await import("../src/server/session-search/indexer");
const { initializeSessionSearchSchema } = await import("../src/server/session-search/schema");
const { SessionSearchStorage } = await import("../src/server/session-search/storage");

assert.equal(resolveLocalEngine(), "sqlite", "run with PERIFUSE_ENGINE=sqlite");

const directory = mkdtempSync(join(tmpdir(), "perifuse-cas-read-smoke-"));
const dbPath = join(directory, "cas.db");
const PLAIN = "plain body";
const DEFLATED = `deflated needle 中文𝄞 ${"x".repeat(2048)}`;
const CAS_MESSAGES = [
  JSON.stringify({ role: "user", content: "cas needle 中文𝄞" }),
  JSON.stringify({ role: "assistant", content: "cas reply" }),
];
const CAS_TEXT = `{"messages":[${CAS_MESSAGES.join(",")}]}`;

/** 把 messages 数组拆成「LITERAL 分隔符 + REF 元素」的 manifest 计划（与 W2a 切片同形）。 */
function messagesPlan(values: string[]) {
  const encoded = values.map((value) => Buffer.from(value, "utf8"));
  const tokens = [{ tag: "literal", bytes: Buffer.from('{"messages":[', "utf8") }];
  encoded.forEach((bytes, index) => {
    if (index > 0) tokens.push({ tag: "literal", bytes: Buffer.from(",", "utf8") });
    tokens.push({ tag: "ref", hash: contentHash(bytes) });
  });
  tokens.push({ tag: "literal", bytes: Buffer.from("]}", "utf8") });
  return { encoded, tokens };
}

const fixture = messagesPlan(CAS_MESSAGES);
const manifest = encodeManifest(fixture.tokens, Buffer.from(CAS_TEXT, "utf8"));
const CAS_BYTES = Buffer.byteLength(CAS_TEXT, "utf8");

/** 读一行正文：走 adapter.query（worker 或 in-process），断言 hydrate 已生效。 */
async function readObservation(adapter, id) {
  const rows = await adapter.query({
    query:
      "SELECT id,project_id,input,input_codec,input_raw_size,output,output_codec,output_raw_size FROM observations WHERE project_id=@projectId AND id=@id",
    params: { projectId: "p", id },
  });
  return rows[0];
}

/** hydrate 后行上不再有 codec 列，project_id 保留（池内容按项目隔离的投影依赖）。 */
function assertObservation(row, id, input) {
  assert.deepEqual(row, { id, project_id: "p", input, output: "" });
}

let workerAdapter: { close(): Promise<void> } | undefined;
let mainAdapter: { close(): Promise<void> } | undefined;
try {
  // ---------------------------------------------------------------- 播种
  mainAdapter = new SQLiteTelemetryAdapter(dbPath);
  await mainAdapter.initialize();
  const raw = mainAdapter.getDatabase();
  await mainAdapter.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o-plain",
        trace_id: "t-cas",
        start_time: "2026-01-01 00:00:00",
        input: PLAIN,
        output: "",
      },
      {
        project_id: "p",
        id: "o-deflated",
        trace_id: "t-cas",
        start_time: "2026-01-01 00:00:01",
        input: DEFLATED,
        output: "",
      },
      {
        project_id: "p",
        id: "o-cas",
        trace_id: "t-cas",
        start_time: "2026-01-01 00:00:02",
        input: "placeholder",
        output: "",
      },
    ],
  });
  await mainAdapter.insert({
    table: "traces",
    records: [
      {
        project_id: "p",
        id: "t-cas",
        timestamp: "2026-01-01 00:00:00",
        input: "placeholder",
        output: "",
      },
    ],
  });
  for (const bytes of fixture.encoded)
    await raw.run(
      "INSERT INTO io_cas_chunks(project_id,content_hash,codec,raw_size,payload) VALUES(?,?,?,?,?)",
      "p",
      contentHash(bytes),
      1,
      bytes.byteLength,
      deflateSync(bytes),
    );
  for (const table of ["observations", "traces"]) {
    const target = table === "observations" ? "o-cas" : "t-cas";
    await raw.run(
      `UPDATE ${table} SET input=?, input_codec=2, input_raw_size=? WHERE project_id='p' AND id=?`,
      manifest,
      table === "observations" ? CAS_BYTES : Buffer.byteLength(CAS_TEXT, "utf8"),
      target,
    );
  }
  const physical = await raw.get(
    "SELECT input_codec AS codec FROM observations WHERE project_id='p' AND id='o-plain'",
  );
  assert.equal(physical.codec, 0, "plain observation stays codec 0");
  const compressed = await raw.get(
    "SELECT input_codec AS codec FROM observations WHERE project_id='p' AND id='o-deflated'",
  );
  assert.equal(compressed.codec, 1, "large observation is deflated");
  console.log("seed: codec 0/1/2 rows + io_cas_chunks ready");

  // ------------------------------------------- in-process（PERIFUSE_READ_WORKERS=0）
  process.env.PERIFUSE_READ_WORKERS = "0";
  assertObservation(await readObservation(mainAdapter, "o-plain"), "o-plain", PLAIN);
  assertObservation(await readObservation(mainAdapter, "o-deflated"), "o-deflated", DEFLATED);
  assertObservation(await readObservation(mainAdapter, "o-cas"), "o-cas", CAS_TEXT);
  console.log("in-process: codec 0/1/2 混合读取，codec 2 已在读快照内 hydrate");
  await mainAdapter.close();
  mainAdapter = undefined;

  // ------------------------------------------------- worker（PERIFUSE_READ_WORKERS=1）
  process.env.PERIFUSE_READ_WORKERS = "1";
  workerAdapter = new SQLiteTelemetryAdapter(dbPath);
  await workerAdapter.initialize();
  assertObservation(await readObservation(workerAdapter, "o-plain"), "o-plain", PLAIN);
  assertObservation(await readObservation(workerAdapter, "o-deflated"), "o-deflated", DEFLATED);
  assertObservation(await readObservation(workerAdapter, "o-cas"), "o-cas", CAS_TEXT);
  console.log("worker: 同一份 reader source 在 read worker 内 hydrate");

  // --------------------------------------------------- 池内容损坏 / 缺失的显式失败
  const firstHash = contentHash(fixture.encoded[0]);
  // 绑定 Buffer 才是 BLOB：`x'00'` 与 BLOB 的 `||` 在 bun:sqlite 下会退化成 TEXT。
  await workerAdapter
    .getDatabase()
    .run(
      "UPDATE io_cas_chunks SET payload = ? WHERE project_id='p' AND content_hash = ?",
      Buffer.concat([deflateSync(fixture.encoded[0]), Buffer.from([0])]),
      firstHash,
    );
  const corrupt = await readObservation(workerAdapter, "o-cas").catch((error) => error);
  assert.equal(corrupt?.message, "IO_CAS_CORRUPT", "池内容与 hash 不符必须显式失败");
  await workerAdapter
    .getDatabase()
    .run(
      "UPDATE io_cas_chunks SET payload = ? WHERE project_id='p' AND content_hash = ?",
      deflateSync(fixture.encoded[0]),
      firstHash,
    );
  await workerAdapter
    .getDatabase()
    .run("DELETE FROM io_cas_chunks WHERE project_id='p' AND content_hash = ?", firstHash);
  const missing = await readObservation(workerAdapter, "o-cas").catch((error) => error);
  assert.equal(missing?.message, "IO_CAS_MISSING", "同快照内缺块必须显式失败");
  await workerAdapter
    .getDatabase()
    .run(
      "INSERT INTO io_cas_chunks(project_id,content_hash,codec,raw_size,payload) VALUES(?,?,?,?,?)",
      "p",
      firstHash,
      1,
      fixture.encoded[0].byteLength,
      deflateSync(fixture.encoded[0]),
    );
  console.log("errors: 池损坏与缺块都显式失败，不返回半截正文");

  // ------------------------------------------ search indexer：快照 + project_id 投影
  const rawSearch = workerAdapter.getDatabase();
  await initializeSessionSearchSchema(rawSearch);
  await new SessionSearchStorage(rawSearch).markDirty({
    projectId: "p",
    kind: "trace",
    id: "t-cas",
    revision: 1,
  });
  assert.ok((await processDirty(rawSearch)) >= 1);
  const occurrence = await rawSearch.get(
    "SELECT COUNT(*) AS n FROM search_occurrences WHERE project_id='p' AND source_id='t-cas'",
  );
  assert.ok(occurrence.n > 0, "CAS 正文必须能在同一快照内装配并进入搜索索引");
  const needle = await rawSearch.get(
    "SELECT COUNT(*) AS n FROM search_texts WHERE project_id='p' AND display_text LIKE '%cas needle%'",
  );
  assert.ok(needle.n > 0, "搜索文本来自 hydrate 后的完整正文");
  console.log("search: readSource 在读快照内 hydrate，正文进入索引");
  await workerAdapter.close();
  workerAdapter = undefined;

  // ------------------------------------------------------------- NO-GO（Turso local）
  process.env.PERIFUSE_ENGINE = "turso";
  assert.equal(resolveLocalEngine(), "turso");
  const noGo = new SQLiteTelemetryAdapter(join(directory, "no-go.db"));
  await noGo.initialize();
  await noGo.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o",
        trace_id: "t",
        start_time: "2026-01-01 00:00:00",
        input: PLAIN,
        output: "",
      },
    ],
  });
  await noGo
    .getDatabase()
    .run("UPDATE observations SET input=x'000102', input_codec=2, input_raw_size=2");
  const noGoAdapter = await readObservation(noGo, "o").catch((error) => error);
  const noGoWorker = await noGo
    .query({
      query: "SELECT input,input_codec,input_raw_size FROM observations WHERE project_id='p'",
    })
    .catch((error) => error);
  for (const error of [noGoAdapter, noGoWorker])
    assert.match(String(error?.message), /verified read snapshot/, "NO-GO 引擎必须按门禁拒绝");
  await noGo.close();
  console.log("no-go: Turso local 在 Bun 上同样拒绝 codec 2（主线程与 worker 路径）");
  process.env.PERIFUSE_ENGINE = "sqlite";

  // --------------------------------------------------------------- bundle 产物验证
  const workerModule = join(sharedRoot, "dist/src/db/local.js");
  assert.ok(existsSync(workerModule), "先构建 shared dist（worker 的 connectionPath）");
  const require = createRequire(join(repoRoot, "packages/cli/package.json"));
  const esbuild = require("esbuild");
  const outfile = join(sharedRoot, "dist/__cas-smoke/pool.cjs");
  await esbuild.build({
    entryPoints: [join(sharedRoot, "src/server/adapters/sqlite-read-pool.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile,
    external: ["@tursodatabase/database", "@tursodatabase/database-common", "bun:sqlite"],
    logLevel: "warning",
  });
  const { SqliteReadPool } = require(outfile);
  const bundledPool = new SqliteReadPool(dbPath, 1, { restartDelayMs: 10 });
  try {
    const rows = await bundledPool.query(
      "SELECT id,project_id,input,input_codec,input_raw_size FROM observations WHERE project_id=@projectId AND id=@id",
      { projectId: "p", id: "o-cas" },
    );
    assert.deepEqual(rows, [{ id: "o-cas", project_id: "p", input: CAS_TEXT }]);
  } finally {
    await bundledPool.close();
  }
  console.log("bundle: esbuild 产物中的 worker 源码仍能 hydrate（读快照 + 池）");

  const serverBundle = join(repoRoot, "packages/cli/dist/server.cjs");
  if (existsSync(serverBundle)) {
    const text = readFileSync(serverBundle, "utf8");
    for (const marker of [
      "__casManifest",
      "__casChunk",
      "guardIoRows",
      "weighIoRow",
      "hydrateIoRows",
    ])
      assert.ok(text.includes(marker), `CLI 产物必须内嵌 ${marker}`);
    assert.ok(
      text.includes("parseManifest: __casManifest.parseManifest"),
      "worker 依赖表达式必须来自生成的源码工厂",
    );
    assert.ok(
      !/[^.\w]parseManifest: parseManifest,/.test(text),
      "注入的依赖不得引用打包作用域里的模块符号",
    );
    console.log("bundle: 真实 CLI 产物内嵌 CAS reader source");
  } else {
    console.log("bundle: 未构建 packages/cli/dist/server.cjs（跳过产物内容检查）");
  }

  console.log("cas-read-smoke: OK");
} finally {
  await workerAdapter?.close();
  await mainAdapter?.close();
  rmSync(directory, { recursive: true, force: true });
}
