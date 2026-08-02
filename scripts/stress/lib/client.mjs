/**
 * Shared client plumbing for stress tests:
 *  - environment configuration parsing
 *  - credential provisioning via the manage API (no direct DB access)
 *  - a timed fetch wrapper with Basic auth
 *
 * Credentials are persisted to scripts/stress/.stress-creds.json (gitignored)
 * so repeated runs reuse the same dedicated stress project and don't pollute
 * real projects. Delete that file (or run teardown.mjs) to start fresh.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CREDS_FILE = path.join(__dirname, "..", ".stress-creds.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function envStr(name, def) {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

export function envInt(name, def) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

export function envFloat(name, def) {
  const v = Number.parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

export function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

/** Common config shared by all stress scripts (override via env vars). */
export function loadConfig() {
  return {
    baseUrl: envStr("BASE", "http://localhost:23432"),
    projectName: envStr("STRESS_PROJECT", "stress-test"),
    duration: envInt("DURATION", 30), // seconds
    concurrency: envInt("CONCURRENCY", 10), // parallel workers
    tracesPerBatch: envInt("BATCH", 5), // traces per ingestion request
    targetRps: envInt("RATE", 0), // 0 = unlimited
    cache: envBool("CACHE", true), // include cache token usage
    progressEvery: envInt("PROGRESS_EVERY", 2), // seconds between progress lines
  };
}

// ---------------------------------------------------------------------------
// Credentials (via manage API — no direct DB access required)
// ---------------------------------------------------------------------------

async function manageJson(baseUrl, p, init = {}) {
  const res = await fetch(`${baseUrl}${p}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`manage ${p} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function basicAuth(publicKey, secretKey) {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

/**
 * Load stress credentials, creating a dedicated project + API key via the
 * manage API on first use. Returns { baseUrl, projectId, projectName,
 * publicKey, secretKey, authHeader }.
 */
export async function ensureCreds(cfg) {
  // Reuse existing credentials if present and still valid.
  if (fs.existsSync(CREDS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
      if (saved.publicKey && saved.secretKey) {
        return { ...saved, authHeader: basicAuth(saved.publicKey, saved.secretKey) };
      }
    } catch {
      // fall through and re-provision
    }
  }

  // Find or create the dedicated stress project.
  const projects = await manageJson(cfg.baseUrl, "/api/manage/projects");
  let project = projects.find((p) => p.name === cfg.projectName);
  if (!project) {
    project = await manageJson(cfg.baseUrl, "/api/manage/projects", {
      method: "POST",
      body: JSON.stringify({ name: cfg.projectName }),
    });
  }

  // Create a fresh API key for the stress run.
  const key = await manageJson(cfg.baseUrl, `/api/manage/projects/${project.id}/keys`, {
    method: "POST",
  });

  const creds = {
    baseUrl: cfg.baseUrl,
    projectId: project.id,
    projectName: project.name,
    publicKey: key.publicKey,
    secretKey: key.secretKey,
  };
  fs.writeFileSync(CREDS_FILE, `${JSON.stringify(creds, null, 2)}\n`, "utf8");
  return { ...creds, authHeader: basicAuth(creds.publicKey, creds.secretKey) };
}

// ---------------------------------------------------------------------------
// Timed HTTP wrapper
// ---------------------------------------------------------------------------

/**
 * Perform one HTTP request against the server, measuring end-to-end latency.
 * Returns { ok, status, ms, bytes, text }.
 *
 * `ok` is true for 2xx plus 207 (ingestion multi-status). Network failures
 * yield { ok:false, status:"network" }.
 */
export async function request(creds, method, p, body) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${creds.baseUrl}${p}`, {
      method,
      headers: {
        Authorization: creds.authHeader,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: "network", ms: performance.now() - t0, bytes: 0, text: "" };
  }
  const ms = performance.now() - t0;
  const text = await res.text();
  const ok = (res.status >= 200 && res.status < 300) || res.status === 207;
  return { ok, status: res.status, ms, bytes: text.length, text };
}

/**
 * POST an ingestion batch and account for per-item outcomes.
 *
 * The ingestion endpoint returns HTTP 207 (multi-status): the request can
 * succeed at the transport level while individual events are rejected (each
 * with its own 4xx inside the body). Counting the whole 207 as a success
 * would silently under-report failures, so we parse the body and:
 *  - mark the request as failed (`ok:false`, status "207-rejected") if ANY
 *    event was rejected, so error stats stay truthful;
 *  - report only the ACCEPTED event count toward events/s throughput;
 *  - log the first rejection reason once per process for quick diagnosis.
 */
let warnedRejection = false;
export async function postIngestion(creds, batch, eventCount) {
  const r = await request(creds, "POST", "/api/public/ingestion", { batch });
  if (!r.ok) return { ...r, events: 0 };

  let rejected = 0;
  try {
    const body = JSON.parse(r.text);
    const errs = Array.isArray(body.errors) ? body.errors : [];
    rejected = errs.length;
    if (rejected > 0 && !warnedRejection) {
      warnedRejection = true;
      const sample = errs[0];
      console.warn(
        `\n[ingestion] per-item rejection detected (HTTP was 207): ` +
          `${rejected}/${eventCount} events rejected. Sample: ` +
          `${sample?.error ?? "?"} — ${String(sample?.message ?? "").slice(0, 200)}`,
      );
    }
  } catch {
    // Non-JSON body: nothing to account for.
  }

  if (rejected > 0) {
    return { ...r, ok: false, status: "207-rejected", events: eventCount - rejected };
  }
  return { ...r, events: eventCount };
}
