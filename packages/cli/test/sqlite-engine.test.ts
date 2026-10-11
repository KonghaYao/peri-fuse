/**
 * CLI coverage for the optional `bun:sqlite` engine.
 *
 * Two layers:
 * - bundle probes (always, once `dist/` is built): the published CJS bundles
 *   keep `bun:sqlite` as an external runtime specifier; Node still works with
 *   the default engine; Node rejects `PERIFUSE_ENGINE=sqlite` before creating
 *   any database; Bun round-trips a real file through the sqlite engine.
 * - daemon end-to-end (opt-in via `PERIFUSE_SQLITE_E2E=1`): `start`/`status`/
 *   `stop` against a temporary `PERIFUSE_HOME`, including the Node rejection
 *   that proves the daemon inherits `PERIFUSE_ENGINE` from the CLI.
 *
 * Run: `bun test test/` (add PERIFUSE_SQLITE_E2E=1 for the daemon layer).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(packageRoot, "..", "..");
const cliBin = path.join(packageRoot, "dist", "index.js");
const serverBundle = path.join(packageRoot, "dist", "server.cjs");
const localBundle = path.join(packageRoot, "dist", "src", "db", "local.js");

const onBun = typeof process.versions.bun === "string";
const built = [cliBin, serverBundle, localBundle].every((file) => fs.existsSync(file));
const bundleSkip = !onBun
  ? "requires the Bun runtime (run with `bun test`)"
  : built
    ? false
    : "build the CLI first: pnpm --filter peri-fuse run build";
const e2eSkip =
  bundleSkip ||
  (process.env.PERIFUSE_SQLITE_E2E === "1"
    ? false
    : "set PERIFUSE_SQLITE_E2E=1 to run the daemon end-to-end tests");

const nodeBinary = process.env.NODE_BINARY ?? "node";
const tempDirectories: string[] = [];

function makeTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Child environment without inherited Turso routing; probes must stay local. */
function probeEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TURSO_")) delete environment[name];
  }
  return environment;
}

/** Writes the shared probe script; it prints one JSON result line. */
function writeProbe(directory: string): string {
  const file = path.join(directory, "probe.mjs");
  fs.writeFileSync(
    file,
    `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  const mod = require(process.env.PROBE_LOCAL_BUNDLE);
  const db = mod.createLocalDatabase(process.env.PROBE_DB, false);
  await db.connect();
  await db.run("CREATE TABLE probe(id INTEGER PRIMARY KEY, name TEXT)");
  await db.run("INSERT INTO probe(id, name) VALUES(?, ?)", 1, "ok");
  const row = await db.get("SELECT name FROM probe WHERE id = ?", 1);
  await db.close();
  console.log(JSON.stringify({ ok: true, row }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }));
}
`,
  );
  return file;
}

function runProbe(
  runtime: string,
  directory: string,
  overrides: Record<string, string>,
): { ok: boolean; code: string | null; row?: { name: string } } {
  const file = writeProbe(directory);
  const result = spawnSync(runtime, [file], {
    cwd: directory,
    env: probeEnvironment({ PROBE_LOCAL_BUNDLE: localBundle, ...overrides }),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describe("cli sqlite engine bundle", { skip: bundleSkip }, () => {
  it("keeps bun:sqlite as an external runtime specifier in the built bundles", () => {
    for (const file of [serverBundle, localBundle]) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(source.includes("bun:sqlite"), `${file} must keep the runtime specifier`);
    }
  });

  it("runs the default Turso engine on Node without resolving bun:sqlite", () => {
    const directory = makeTempDirectory("peri-sqlite-node-turso-");
    const database = path.join(directory, "default.db");
    const result = runProbe(nodeBinary, directory, {
      PERIFUSE_ENGINE: "",
      PROBE_DB: `file:${database}`,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.row, { name: "ok" });
    assert.ok(fs.existsSync(database), "the Node default engine must create the database file");
  });

  it("rejects PERIFUSE_ENGINE=sqlite on Node before creating any file", () => {
    const directory = makeTempDirectory("peri-sqlite-node-reject-");
    const target = path.join(directory, "nested", "reject.db");
    const result = runProbe(nodeBinary, directory, {
      PERIFUSE_ENGINE: "sqlite",
      PROBE_DB: `file:${target}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PERIFUSE_SQLITE_REQUIRES_BUN");
    assert.equal(fs.existsSync(path.dirname(target)), false, "the engine must not mkdir");
    assert.equal(fs.existsSync(target), false);
  });

  it("round-trips a real file through the sqlite engine on Bun", () => {
    const directory = makeTempDirectory("peri-sqlite-bun-roundtrip-");
    const database = path.join(directory, "sqlite.db");
    const result = runProbe(process.execPath, directory, {
      PERIFUSE_ENGINE: "sqlite",
      PROBE_DB: `file:${database}`,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.row, { name: "ok" });
    const header = fs.readFileSync(database).subarray(0, 16).toString("utf8");
    assert.equal(header, "SQLite format 3\u0000");
  });
});

/** The port the CLI would actually use: repo `.env` wins over the process env. */
function effectivePort(): number {
  let fromEnvFile: string | undefined;
  const envPath = path.join(repoRoot, ".env");
  if (fs.existsSync(envPath)) {
    fromEnvFile = dotenv.parse(fs.readFileSync(envPath, "utf8")).LITE_SERVER_PORT;
  }
  const parsed = Number.parseInt(fromEnvFile ?? process.env.LITE_SERVER_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 23332;
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function runCli(args: string[], home: string, engine: string, timeout: number) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    env: probeEnvironment({ PERIFUSE_HOME: home, PERIFUSE_ENGINE: engine }),
    encoding: "utf8",
    timeout,
  });
}

describe("cli sqlite daemon end-to-end", { skip: e2eSkip }, () => {
  for (const engine of [
    { label: "sqlite engine", value: "sqlite" },
    { label: "default turso engine", value: "" },
  ]) {
    it(`starts, reports and stops a Bun daemon on the ${engine.label}`, async (t) => {
      const port = effectivePort();
      if (await portInUse(port)) {
        t.skip(`port ${port} is already in use; stop the running server first`);
        return;
      }
      const home = makeTempDirectory("peri-sqlite-e2e-start-");
      try {
        const start = runCli(["start"], home, engine.value, 30_000);
        assert.equal(start.status, 0, start.stdout + start.stderr);

        const state = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8")) as {
          pid: number;
          port: number;
        };
        const health = await fetch(`http://localhost:${state.port}/api/public/health`);
        assert.equal(health.ok, true, `health check failed for pid ${state.pid}`);

        for (const file of ["langfuse.turso.db", "telemetry.turso.db"]) {
          assert.ok(fs.existsSync(path.join(home, file)), `${file} must be created`);
        }

        const status = runCli(["status"], home, engine.value, 15_000);
        assert.equal(status.status, 0, status.stdout + status.stderr);

        const stop = runCli(["stop"], home, engine.value, 20_000);
        assert.equal(stop.status, 0, stop.stdout + stop.stderr);
        assert.equal(fs.existsSync(path.join(home, "server.json")), false);
        assert.throws(() => process.kill(state.pid, 0), /ESRCH/);
      } finally {
        if (fs.existsSync(path.join(home, "server.json"))) {
          runCli(["stop"], home, engine.value, 20_000);
        }
      }
    });
  }

  it("propagates the engine to the daemon: Node rejects it and creates no database", () => {
    const home = makeTempDirectory("peri-sqlite-e2e-node-");
    const start = spawnSync(nodeBinary, [cliBin, "start"], {
      env: probeEnvironment({ PERIFUSE_HOME: home, PERIFUSE_ENGINE: "sqlite" }),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(start.status, 1, start.stdout + start.stderr);
    const files = fs.existsSync(home) ? fs.readdirSync(home) : [];
    assert.equal(
      files.some((file) => file.endsWith(".db")),
      false,
      `no database may be created, found: ${files.join(", ")}`,
    );
    const log = fs.readFileSync(path.join(home, "server.log"), "utf8");
    assert.match(log, /PERIFUSE_ENGINE=sqlite requires Bun/);
  });
});
