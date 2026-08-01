/**
 * E2E runner: starts a throwaway server, extracts bootstrap credentials,
 * runs the Langfuse SDK E2E test, then cleans up.
 *
 * Usage:  node e2e/run.mjs
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, "..");
const PORT = 23456;
const HOME = `/tmp/pf-e2e-sdk-${Date.now()}`;

fs.mkdirSync(HOME, { recursive: true });

console.log(`[runner] Starting server on port ${PORT} (PERIFUSE_HOME=${HOME})…`);

const server = spawn("node", ["dist/index.js"], {
  cwd: serverDir,
  env: { ...process.env, PERIFUSE_HOME: HOME, LITE_SERVER_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (d) => { serverOutput += d.toString(); });
server.stderr.on("data", (d) => { serverOutput += d.toString(); });

function waitForServer(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/public/health`);
        if (res.ok) return resolve();
      } catch { /* not ready yet */ }
      if (Date.now() - start > timeoutMs) return reject(new Error("Server start timeout"));
      setTimeout(poll, 300);
    };
    poll();
  });
}

function extractCredentials() {
  const pkMatch = serverOutput.match(/Public Key:\s+(pk-lf-[a-f0-9-]+)/);
  const skMatch = serverOutput.match(/Secret Key:\s+(sk-lf-[a-f0-9-]+)/);
  if (!pkMatch || !skMatch) return null;
  return { pk: pkMatch[1], sk: skMatch[1] };
}

function waitForCredentials(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const creds = extractCredentials();
      if (creds) return resolve(creds);
      if (Date.now() - start > timeoutMs) return reject(new Error("Credentials not found in server output"));
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function main() {
  try {
    await waitForServer();
    console.log("[runner] Server is up.");

    let creds;
    try {
      creds = await waitForCredentials();
    } catch {
      console.error("[runner] Could not extract bootstrap credentials from server output:");
      console.error(serverOutput.slice(-800));
      process.exit(1);
    }
    console.log(`[runner] Credentials: ${creds.pk} / ${creds.sk.slice(0, 15)}…`);

    console.log("[runner] Running Langfuse SDK E2E test…\n");
    const result = spawn("node", [path.join(__dirname, "langfuse-sdk-e2e.mjs")], {
      cwd: serverDir,
      env: { ...process.env, BASE: `http://localhost:${PORT}`, PK: creds.pk, SK: creds.sk },
      stdio: "inherit",
    });

    const code = await new Promise((resolve) => {
      result.on("close", resolve);
    });

    // --- Restart test ---
    console.log("\n[runner] Restarting server (existing DB) to verify idempotency…");
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));

    const server2 = spawn("node", ["dist/index.js"], {
      cwd: serverDir,
      env: { ...process.env, PERIFUSE_HOME: HOME, LITE_SERVER_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let server2Output = "";
    server2.stdout.on("data", (d) => { server2Output += d.toString(); });
    server2.stderr.on("data", (d) => { server2Output += d.toString(); });

    try {
      await waitForServer();
      const hasCrash = server2Output.includes("already exists");
      const noBootstrap = !server2Output.includes("First Boot Credentials");
      console.log(`[runner] Restart: no crash=${!hasCrash}, no re-bootstrap=${noBootstrap}`);

      // Verify data persisted
      const res = await fetch(`http://localhost:${PORT}/api/public/traces?limit=1`, {
        headers: { Authorization: "Basic " + Buffer.from(`${creds.pk}:${creds.sk}`).toString("base64") },
      });
      const data = await res.json();
      const persisted = res.ok && (data.data?.length ?? 0) > 0;
      console.log(`[runner] Data persisted after restart: ${persisted}`);

      if (hasCrash || !persisted) {
        console.error("[runner] Restart verification FAILED");
        console.error(server2Output.slice(-500));
        server2.kill("SIGTERM");
        process.exit(1);
      }
    } finally {
      server2.kill("SIGTERM");
    }

    console.log(`\n[runner] E2E complete (exit code ${code}).`);
    process.exit(code);
  } catch (err) {
    console.error("[runner] Fatal:", err.message);
    console.error(serverOutput.slice(-1000));
    server.kill("SIGTERM");
    process.exit(1);
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main();
