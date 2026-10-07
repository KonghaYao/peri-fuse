import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ROLES = {
  metadata: {
    legacy: "langfuse.db",
    current: "langfuse.turso.db",
    migrations: "packages/shared/drizzle",
  },
  telemetry: {
    legacy: "telemetry.db",
    current: "telemetry.turso.db",
    migrations: "packages/shared/telemetry-drizzle",
  },
  gateway: {
    legacy: "gateway.db",
    current: "gateway.turso.db",
    migrations: "packages/gateway/drizzle",
  },
};
export const HELP = `Usage: bash scripts/migrate-legacy-db.sh [options]

  --source-dir DIR        Legacy database/key directory (default: PERIFUSE_HOME or ~/.peri-fuse)
  --target-dir DIR        Output directory (default: source directory)
  --role ROLE             all, metadata, telemetry, gateway (default: all)
  --metadata-source FILE  Override the legacy metadata file
  --telemetry-source FILE Override the legacy telemetry file
  --gateway-source FILE   Override the legacy Gateway file
  --batch-rows N          Maximum rows per transaction (default: 200; bindings also limited)
  --batch-mib N           Maximum approximate batch payload (default: 8 MiB)
  --max-row-mib N         Reject larger individual rows (default: 64 MiB)
  --offline              Confirm all source/destination writers are stopped (required for writes)
  --resume               Resume only this script's matching interrupted migration
  --dry-run              Inspect schemas/counts without creating output files
  --help                 Show this help

Keep the service stopped until every database is published. Source files are opened read-only,
including their WAL. Existing destination databases are never replaced. Keep original databases
and their WAL files as your rollback backup. This script only creates local embedded databases.
`;

export function parseOptions(argumentsList) {
  const options = {
    role: "all",
    batchRows: 200,
    batchBytes: 8 * 1024 * 1024,
    maxRowBytes: 64 * 1024 * 1024,
  };
  const flags = {
    "--offline": "offline",
    "--resume": "resume",
    "--dry-run": "dryRun",
    "--help": "help",
  };
  const values = {
    "--source-dir": "sourceDir",
    "--target-dir": "targetDir",
    "--role": "role",
    "--metadata-source": "metadataSource",
    "--telemetry-source": "telemetrySource",
    "--gateway-source": "gatewaySource",
    "--batch-rows": "batchRows",
    "--batch-mib": "batchMib",
    "--max-row-mib": "maxRowMib",
  };
  for (let index = 0; index < argumentsList.length; index++) {
    const flag = argumentsList[index];
    if (flag in flags) options[flags[flag]] = true;
    else if (
      flag in values &&
      argumentsList[index + 1] &&
      !argumentsList[index + 1].startsWith("--")
    )
      options[values[flag]] = argumentsList[++index];
    else throw new Error(`Unknown option or missing value: ${flag}`);
  }
  if (options.help) return options;
  if (options.role !== "all" && !(options.role in ROLES)) throw new Error("Invalid --role");
  for (const name of ["batchRows", "batchMib", "maxRowMib"]) {
    if (options[name] === undefined) continue;
    const number = Number(options[name]);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > (name === "batchRows" ? 10000 : 1024)
    )
      throw new Error(`Invalid ${name}: expected a positive bounded integer`);
    options[name] = number;
  }
  if (options.batchMib) options.batchBytes = options.batchMib * 1024 * 1024;
  if (options.maxRowMib) options.maxRowBytes = options.maxRowMib * 1024 * 1024;
  options.sourceDir = realpathSync(
    resolve(options.sourceDir ?? process.env.PERIFUSE_HOME ?? join(homedir(), ".peri-fuse")),
  );
  options.targetDir = resolve(options.targetDir ?? options.sourceDir);
  if (!options.dryRun && !options.offline)
    throw new Error(
      "Stop the service and all writers first, then pass --offline. Use --dry-run for inspection.",
    );
  return options;
}

export function readAssets(directory) {
  return [".salt", ".encryption-key"]
    .filter((name) => existsSync(join(directory, name)))
    .map((name) => {
      const bytes = readFileSync(join(directory, name));
      if (!bytes.length || bytes.length > 4096) throw new Error(`Invalid key file: ${name}`);
      return { name, bytes, hash: createHash("sha256").update(bytes).digest("hex") };
    });
}

export function validateAssets(directory, assets) {
  for (const asset of assets) {
    const filename = join(directory, asset.name);
    if (existsSync(filename) && !readFileSync(filename).equals(asset.bytes))
      throw new Error(
        `Destination ${asset.name} differs from the source; use a new destination directory`,
      );
  }
}

export function copyAssets(directory, assets) {
  validateAssets(directory, assets);
  for (const asset of assets)
    if (!existsSync(join(directory, asset.name)))
      writeFileSync(join(directory, asset.name), asset.bytes, { mode: 0o600, flag: "wx" });
}

export function acquireLock(directory, resume) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, ".legacy-turso-migration.lock");
  if (existsSync(filename)) {
    const previous = JSON.parse(readFileSync(filename, "utf8"));
    if (!resume || previous.host !== hostname() || !Number.isSafeInteger(previous.pid))
      throw new Error("Migration lock exists; check its owner before retrying with --resume");
    try {
      process.kill(previous.pid, 0);
      throw new Error("Another migration process is still running");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    unlinkSync(filename);
  }
  const contents = JSON.stringify({ pid: process.pid, host: hostname(), id: randomUUID() });
  writeFileSync(filename, contents, { mode: 0o600, flag: "wx" });
  return () => {
    if (existsSync(filename) && readFileSync(filename, "utf8") === contents) unlinkSync(filename);
  };
}

export function checkDiskSpace(directory, bytes) {
  let parent = directory;
  while (!existsSync(parent)) parent = dirname(parent);
  const filesystem = statfsSync(parent, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const required = BigInt(Math.ceil(bytes * 1.3 + 128 * 1024 * 1024));
  if (available < required)
    throw new Error(
      `Insufficient free disk space: approximately ${Number(required / 1024n / 1024n)} MiB required for new databases plus WAL/index headroom`,
    );
}
