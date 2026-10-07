import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireLock,
  checkDiskSpace,
  copyAssets,
  HELP,
  parseOptions,
  ROLES,
  ROOT,
  readAssets,
  validateAssets,
} from "./config.mjs";
import { copyTable, interruption, rebuildTrigrams, verifyTable } from "./copy.mjs";
import { buildPlans, openSource } from "./source.mjs";
import {
  checkpoint,
  completeTarget,
  createSchema,
  describeTables,
  finishSchema,
  getState,
  initializeTarget,
  openTarget,
  publish,
  readMigrations,
  schemaDigest,
  validateExistingTarget,
} from "./target.mjs";

let requestedStop = false;
const stopped = () => requestedStop;
process.on("SIGINT", () => {
  requestedStop = true;
});
process.on("SIGTERM", () => {
  requestedStop = true;
});

async function run() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const startedAt = new Date().toISOString();
  const assets = readAssets(options.sourceDir);
  validateAssets(options.targetDir, assets);
  const selected = options.role === "all" ? Object.keys(ROLES) : [options.role];
  const jobs = [];
  let release;
  try {
    for (const role of selected) {
      const definition = ROLES[role];
      const configuredPath = options[`${role}Source`] ?? join(options.sourceDir, definition.legacy);
      const sourcePath = resolve(
        configuredPath.startsWith("file:") ? configuredPath.slice(5) : configuredPath,
      );
      if (!existsSync(sourcePath)) {
        if (options.role !== "all" || options[`${role}Source`])
          throw new Error(`Source file does not exist: ${sourcePath}`);
        console.log(`[${role}] no legacy database found; skipped`);
        continue;
      }
      const source = openSource(sourcePath);
      const migrations = readMigrations(join(ROOT, definition.migrations));
      const filename = join(options.targetDir, definition.current);
      const staging = join(options.targetDir, `.${definition.current}.migrating`);
      const identity = {
        version: 1,
        role,
        source: source.path,
        fingerprint: source.identity,
        schema: schemaDigest(migrations),
        assets: assets.map(({ name, hash }) => ({ name, hash })),
      };
      const job = { role, source, migrations, filename, staging, identity };
      jobs.push(job);
      if (
        [filename, staging].some((path) => existsSync(path) && realpathSync(path) === source.path)
      )
        throw new Error("Source and destination database must be different files");
      const template = await openTarget(":memory:");
      try {
        await createSchema(template, migrations);
        Object.assign(job, buildPlans(source, await describeTables(template)));
      } finally {
        await template.close();
      }
      console.log(
        `[${role}] ${job.plans.reduce((count, plan) => count + plan.count, 0)} rows; source ${(statSync(source.path).size / 1024 / 1024).toFixed(1)} MiB`,
      );
      if (job.skipped.length)
        console.log(`[${role}] omitted legacy internal/derived tables: ${job.skipped.join(", ")}`);
      if (!options.dryRun && (existsSync(filename) || existsSync(staging)) && !options.resume)
        throw new Error(
          "Destination/staging database exists; it is never replaced. Use --resume only for an interrupted migration from this script.",
        );
    }
    if (!jobs.length) throw new Error("No legacy databases found");
    if (options.dryRun) {
      for (const job of jobs)
        for (const plan of job.plans)
          console.log(`[${job.role}] ${plan.sourceName} -> ${plan.name}: ${plan.count} rows`);
      console.log("Dry run complete; no destination files created.");
      return;
    }
    checkDiskSpace(
      options.targetDir,
      jobs
        .filter((job) => !existsSync(job.filename))
        .reduce((bytes, job) => {
          const wal = `${job.source.path}-wal`;
          const sourceBytes =
            statSync(job.source.path).size + (existsSync(wal) ? statSync(wal).size : 0);
          const importedBytes = existsSync(job.staging) ? statSync(job.staging).size : 0;
          return bytes + Math.max(0, sourceBytes - importedBytes);
        }, 0),
    );
    release = acquireLock(options.targetDir, options.resume);
    for (const job of jobs) {
      if (stopped()) throw interruption();
      const log = (message) => console.log(`[${job.role}] ${message}`);
      const published = existsSync(job.filename);
      const existed = published || existsSync(job.staging);
      const complete = existed
        ? validateExistingTarget(published ? job.filename : job.staging, job.identity)
        : false;
      if (published) {
        if (!complete) throw new Error("Published destination is not a completed import");
        log("matching migration was already published; left unchanged");
        job.published = true;
        continue;
      }
      const db = await openTarget(job.staging);
      try {
        await initializeTarget(db, job.migrations, job.identity, existed);
        for (const plan of job.plans) await copyTable(job.source, db, plan, options, stopped, log);
        for (const plan of job.plans) await verifyTable(db, plan, stopped, log);
        if (job.role === "telemetry")
          await rebuildTrigrams(job.source, db, job.plans, stopped, log);
        if (stopped()) throw interruption();
        log("building secondary indexes and validating foreign keys");
        await finishSchema(db, job.migrations);
        job.report = {
          startedAt,
          completedAt: new Date().toISOString(),
          ...job.identity,
          skipped: job.skipped,
          tables: [],
        };
        for (const plan of job.plans)
          job.report.tables.push({
            table: plan.name,
            ...(await getState(db, `table:${plan.name}`)),
          });
        if (job.role === "telemetry") job.report.trigrams = await getState(db, "trigrams");
        job.source.assertUnchanged();
      } finally {
        try {
          await checkpoint(db);
        } finally {
          await db.close();
        }
      }
    }
    if (stopped()) throw interruption();
    for (const job of jobs) job.source.assertUnchanged();
    for (const job of jobs) {
      if (stopped()) throw interruption();
      if (!job.published) {
        console.log(`[${job.role}] checking SQLite integrity and foreign keys independently`);
        await completeTarget(job.staging);
        job.report.integrity = { foreignKeys: "ok", sqliteQuickCheck: "ok" };
        job.report.completedAt = new Date().toISOString();
      }
    }
    if (stopped()) throw interruption();
    for (const asset of assets)
      if (!readFileSync(join(options.sourceDir, asset.name)).equals(asset.bytes))
        throw new Error(`Source ${asset.name} changed during migration`);
    copyAssets(options.targetDir, assets);
    for (const job of jobs) {
      if (!job.published) publish(job.staging, job.filename, job.report);
      console.log(`[${job.role}] ready: ${job.filename}`);
    }
    console.log(
      "Migration complete. Original databases are untouched. Keep their DB/WAL files for rollback.",
    );
    console.log(
      `Start the new service with PERIFUSE_HOME=${JSON.stringify(options.targetDir)}. Remove old local-path overrides and unset TURSO_* remote settings, or explicitly point each path at the new .turso.db files.`,
    );
    for (const [name, variable] of [
      [".salt", "SALT"],
      [".encryption-key", "GATEWAY_ENCRYPTION_KEY"],
    ]) {
      if (!assets.some((asset) => asset.name === name))
        console.log(
          `Source ${name} is absent; preserve your existing ${variable} environment value when restarting.`,
        );
    }
  } finally {
    for (const job of jobs) job.source.close();
    release?.();
  }
}

run().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = error.code === "MIGRATION_INTERRUPTED" ? 130 : 1;
});
