import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "peri-ingestion-test-"));
mkdirSync(join(root, "home"));
// 不继承业务环境，不加载 .env，也不使用 server 的固定目录 global setup。
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  NODE_ENV: "test",
  LANGFUSE_MODE: "lite",
  PERIFUSE_HOME: join(root, "home"),
  DATABASE_URL: `file:${join(root, "auth.db")}`,
  LANGFUSE_SQLITE_DB_PATH: join(root, "telemetry.db"),
  GATEWAY_DB_URL: join(root, "gateway.db"),
  PERIFUSE_READ_WORKERS: "0",
  PERIFUSE_IO_COMPRESSION_WRITE: "off",
  SALT: randomBytes(32).toString("hex"),
};
const check = process.argv[2];
if (check === "pnpm-typecheck" || check === "pnpm-lint" || check === "lint") {
  const local = check === "lint";
  const result = spawnSync(
    local ? fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url)) : "pnpm",
    local ? ["check", ...process.argv.slice(3)] : ["run", check.slice(5)],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...env, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0" },
      stdio: "inherit",
    },
  );
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
// search lifecycle 会加载编译后的模块；测试前构建，禁止误用旧 dist 得到假阳性。
if (!check?.startsWith("typecheck") && check !== "build-shared") {
  const build = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../packages/shared/node_modules/typescript/bin/tsc", import.meta.url)),
      "--incremental",
      "false",
    ],
    { cwd: new URL("../packages/shared/", import.meta.url), env, stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const result = spawnSync(
  process.execPath,
  check?.startsWith("typecheck") || check === "build-shared"
    ? [
        fileURLToPath(
          new URL("../packages/shared/node_modules/typescript/bin/tsc", import.meta.url),
        ),
        ...(check === "build-shared" ? [] : ["--noEmit"]),
        "--incremental",
        "false",
      ]
    : [
        fileURLToPath(
          new URL("../packages/shared/node_modules/vitest/vitest.mjs", import.meta.url),
        ),
        "run",
        "--config",
        "vitest.ingestion.config.ts",
        ...process.argv.slice(2).filter((arg) => !arg.startsWith("typecheck")),
      ],
  {
    cwd: new URL(
      check === "typecheck-server" ? "../packages/server/" : "../packages/shared/",
      import.meta.url,
    ),
    env,
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
