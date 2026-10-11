import { dirname, join } from "node:path";
import { vi } from "vitest";
import { withLocalTransaction } from "../../db/local";
import { hydrateIoRows } from "../io-cas/read";
import { IO_CAS_READ_BUDGET } from "../io-cas/reader-source";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

/**
 * W5 写协议测试的共享夹具（拆分自 `io-cas-write-isolated.test.ts`）：
 * 隔离库文件、CAS 开启的 adapter 生命周期、池/行的查询与「同事务 hydrate 后读回正文」。
 *
 * 本文件不是测试（不以 `.test.ts` 结尾），只被两个 isolated 测试文件导入。
 */

export const MESSAGES = Array.from({ length: 40 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `中文观测 needle ${index} ${"x".repeat(600)}`,
}));
export const INPUT = JSON.stringify({ messages: MESSAGES });
export const SMALL_INPUT = JSON.stringify({ messages: [{ role: "user", content: "small" }] });

const adapters: SQLiteTelemetryAdapter[] = [];

export function isolatedFile(name: string): string {
  const base = process.env.LANGFUSE_SQLITE_DB_PATH;
  if (!base?.includes("peri-ingestion-test-")) throw new Error("必须通过隔离入口运行");
  return join(dirname(base), `${name}.db`);
}

export async function openCasAdapter(
  name: string,
  options: { cas?: "on" | "off"; workers?: string; projects?: string } = {},
): Promise<SQLiteTelemetryAdapter> {
  vi.stubEnv("PERIFUSE_IO_CAS_WRITE", options.cas ?? "on");
  vi.stubEnv("PERIFUSE_IO_COMPRESSION_WRITE", "on");
  vi.stubEnv("PERIFUSE_READ_WORKERS", options.workers ?? "0");
  if (options.projects !== undefined) vi.stubEnv("PERIFUSE_IO_CAS_PROJECTS", options.projects);
  const adapter = new SQLiteTelemetryAdapter(isolatedFile(name));
  adapters.push(adapter);
  await adapter.initialize();
  return adapter;
}

export async function closeCasAdapters(): Promise<void> {
  for (const adapter of adapters) await adapter.close();
  adapters.length = 0;
}

export async function poolCount(adapter: SQLiteTelemetryAdapter, projectId = "p"): Promise<number> {
  const row = (await adapter
    .getDatabase()
    .get("SELECT COUNT(*) AS n FROM io_cas_chunks WHERE project_id=?", projectId)) as {
    n: number;
  };
  return Number(row.n);
}

export async function storedIo(adapter: SQLiteTelemetryAdapter, id: string) {
  return (await adapter
    .getDatabase()
    .get(
      "SELECT input_codec, input_raw_size, length(input) AS stored FROM observations WHERE project_id='p' AND id=?",
      id,
    )) as { input_codec: number; input_raw_size: number; stored: number };
}

/**
 * 在同一事务内 hydrate 后读回正文。
 *
 * 只覆盖写协议的读回；真实读路径的门禁（NO-GO 引擎拒绝 codec 2）由 W4b 的
 * `io-read-isolated` / `io-api-isolated` 覆盖，Bun 轨道由 `cas-read-smoke.ts` 端到端覆盖。
 */
export async function readInput(adapter: SQLiteTelemetryAdapter, id: string): Promise<string> {
  const db = adapter.getDatabase();
  const row = (await db.get(
    "SELECT project_id,input,input_codec,input_raw_size FROM observations WHERE project_id='p' AND id=?",
    id,
  )) as Record<string, unknown>;
  await withLocalTransaction(db, (tx) => hydrateIoRows(tx, [row], IO_CAS_READ_BUDGET));
  return String(row.input);
}
