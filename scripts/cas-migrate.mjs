/**
 * CAS 回填 / expand 管理命令（W7 的 CAS 管理命令载体，D-14 定案）。
 *
 * 载体选择理由：跟随 `scripts/prune-telemetry.mjs` 先例（Node/Bun 脚本、按 dist 运行、
 * 不扩大 `packages/cli` 的打包面与 bun test 面）。**运行环境**：CAS 的 GO 引擎是
 * `PERIFUSE_ENGINE=sqlite`（bun:sqlite，具备已验证的读快照能力），因此实际执行用
 *    PERIFUSE_ENGINE=sqlite bun scripts/cas-migrate.mjs --project <id>
 * 在 Turso local/remote 上命令会按 W1 门禁拒绝执行（NO-GO 引擎禁止产生 codec 2）。
 * 前置：`pnpm --filter @peri-fuse/shared run build`（脚本按 dist 运行）。
 *
 * Usage:
 *   bun scripts/cas-migrate.mjs --project <id> [--job backfill-v1|expand-v1]
 *     [--dry-run] [--resume] [--pass <n>] [--cursor <id>]
 *     [--rate-mib <n=5>] [--disk-reserve-mib <n=512>] [--pause-file <path>]
 *     [--lock-wait-ms <n=50>] [--window-seconds <n=60>] [--business-ratio <r=0.2>]
 *     [--business-baseline-ms <n>] [--compress on|off]
 *     [--sample-rows <n=2000>] [--rescan-rows <n=0=全部>] [--no-verify]
 *     [--acknowledge-writers-stopped]   # expand-v1 必填
 *
 * 退出码：0 = done，2 = paused（显式暂停/停止条件），1 = failed（损坏/校验不过），
 * 4 = 环境不允许（引擎门禁/缺表/缺参数）。
 *
 * 停止条件（W7 ⑦）：SIGINT/SIGTERM/pause file、磁盘预留、写锁等待 p95 > 阈值、
 * 业务延迟代理 p95 比基线恶化 > 比例——全部在批与批之间判定，当前批提交后才暂停。
 */

import { existsSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

process.env.LANGFUSE_MODE = "lite";
const {
  assertReadSnapshotSupported,
  isRemoteDatabaseUrl,
  localFileExists,
  openLocalDatabase,
  resolveDatabaseConfig,
} = await import("../packages/shared/dist/src/db/local.js");
const { IO_CAS_ROOTS_INDEX_SQL } = await import(
  "../packages/shared/dist/src/db/telemetry/io-cas-tables.js"
);
const { dryRunCasMigration, expandPreflight } = await import(
  "../packages/shared/dist/src/server/io-cas/migration-audit.js"
);
const { runCasMigration } = await import("../packages/shared/dist/src/server/io-cas/migration.js");

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argument = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const number = (name, fallback) => {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}: not a number`);
  return value;
};
const fail = (message, code = 4) => {
  console.error(`[cas-migrate] ${message}`);
  process.exit(code);
};

const projectId = argument("--project");
if (!projectId) fail("Pass --project <id>.", 4);
const job = argument("--job") ?? "backfill-v1";
if (job !== "backfill-v1" && job !== "expand-v1") fail(`Unknown --job ${job}.`, 4);
const dryRun = has("--dry-run");
const resume = has("--resume");
const pass = argument("--pass") === undefined ? undefined : number("--pass", 1);
const cursor = argument("--cursor");
const compressArg = argument("--compress");
if (compressArg !== undefined && compressArg !== "on" && compressArg !== "off")
  fail("--compress must be on or off.", 4);
const compress =
  compressArg === undefined
    ? process.env.PERIFUSE_IO_COMPRESSION_WRITE === "on"
    : compressArg === "on";
if (job === "expand-v1" && !dryRun && !has("--acknowledge-writers-stopped"))
  fail(
    "expand-v1 requires --acknowledge-writers-stopped: disable new CAS writes and stop all " +
      "other CAS writers first (design §10.2), otherwise codec 2 can reappear behind the cursor.",
    4,
  );

const config = resolveDatabaseConfig(
  "telemetry",
  join(process.env.PERIFUSE_HOME || join(homedir(), ".peri-fuse"), "telemetry.turso.db"),
);
const dbPath = config.url;
if (isRemoteDatabaseUrl(dbPath)) fail("Remote Turso is not a verified snapshot engine (W1).", 4);
if (!localFileExists(dbPath)) fail(`Telemetry database does not exist: ${dbPath}`, 4);

const db = await openLocalDatabase(dbPath, false, config.authToken);
const table = async (name) =>
  Boolean(await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
for (const name of ["observations", "io_cas_chunks", "io_cas_migration_state"])
  if (!(await table(name)))
    fail(`Missing table ${name}; initialize the telemetry schema first.`, 4);
const columns = await db.all("PRAGMA table_info(observations)");
if (!columns.some((column) => column.name === "input_codec"))
  fail("observations.input_codec is missing; run the current server once to apply migrations.", 4);

try {
  assertReadSnapshotSupported(db);
} catch {
  fail(
    "This engine cannot prove read snapshot capability (W1 gate); codec 2 must not be produced. " +
      "Run with PERIFUSE_ENGINE=sqlite (bun) — see docs/bun-runtime.md.",
    4,
  );
}

// D-1：codec 2 根扫描索引**不在**启动 migration 里建，由本命令在首次扫描前显式、
// 幂等地创建；在 1.5GB observations 上这是一次全表扫描，耗时会打印出来。
const indexStarted = Date.now();
await db.exec(IO_CAS_ROOTS_INDEX_SQL);
console.error(`[cas-migrate] ${IO_CAS_ROOTS_INDEX_SQL} (${Date.now() - indexStarted}ms)`);

if (dryRun) {
  if (job === "expand-v1")
    console.log(JSON.stringify(await expandPreflight(db, projectId), null, 2));
  else
    console.log(
      JSON.stringify(
        await dryRunCasMigration(db, {
          projectId,
          limit: number("--sample-rows", 2000),
          compress,
        }),
        null,
        2,
      ),
    );
  await db.close();
  process.exit(0);
}

let pauseRequested = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (pauseRequested) process.exit(130);
    pauseRequested = true;
    console.error(`[cas-migrate] ${signal} received; pausing after the current batch`);
  });
const pauseFile = argument("--pause-file");
const diskReserveBytes = number("--disk-reserve-mib", 512) * 1024 * 1024;
const freeBytes = () => {
  const stats = statfsSync(dirname(dbPath), { bigint: false });
  return stats.bavail * stats.bsize;
};
const rescanRows = number("--rescan-rows", 0);

const report = await runCasMigration(db, {
  projectId,
  job,
  pass,
  resume,
  cursor: cursor ?? undefined,
  compress,
  rateBytesPerSecond: number("--rate-mib", 5) * 1024 * 1024,
  verify: !has("--no-verify"),
  rescanRows: rescanRows > 0 ? rescanRows : undefined,
  stops: {
    pauseRequested: () => pauseRequested || (pauseFile !== undefined && existsSync(pauseFile)),
    diskFreeBytes: freeBytes,
    diskReserveBytes,
    lockWaitP95Ms: number("--lock-wait-ms", 50),
    windowMs: number("--window-seconds", 60) * 1000,
    businessDegradeRatio: number("--business-ratio", 0.2),
    businessBaselineMs: argument("--business-baseline-ms")
      ? number("--business-baseline-ms", 0)
      : undefined,
  },
  onProgress: (progress) => {
    console.error(
      `[cas-migrate] batches=${progress.batches} scanned=${progress.scanned} ` +
        `converted=${progress.converted} skipped=${progress.skipped} ` +
        `cursor=${progress.cursorId ?? "-"} ` +
        `rate=${(progress.bytesPerSecond / 1024 / 1024).toFixed(2)}MiB/s ` +
        `lockP95=${progress.lockWaitP95Ms?.toFixed(1) ?? "-"}ms ` +
        `businessP95=${progress.businessP95Ms?.toFixed(1) ?? "-"}ms`,
    );
  },
});

// 结束校验（残余重扫 + codec 2 完整重组 / expand 后 codec 2 归零）已由 runCasMigration
// 内联完成并写进报告；这里只补库文件与磁盘的独立读数，便于报告直接引用。
report.databaseBytes = statSync(dbPath).size;
report.walBytes = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
report.diskFreeBytes = freeBytes();

console.log(JSON.stringify(report, null, 2));
await db.close();
process.exit(report.status === "done" ? 0 : report.status === "paused" ? 2 : 1);
