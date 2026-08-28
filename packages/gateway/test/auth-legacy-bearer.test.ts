import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayEnv } from "../src/app.js";

interface SlowScanGate {
  secret: string | null;
  entered: (() => void) | null;
  waitForRelease: Promise<void> | null;
  failIfComparedSecret: string | null;
}

const slowScanGate = vi.hoisted<SlowScanGate>(() => ({
  secret: null,
  entered: null,
  waitForRelease: null,
  failIfComparedSecret: null,
}));

vi.mock("bcryptjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bcryptjs")>();
  return {
    ...actual,
    compare: async (secret: string, hash: string) => {
      if (slowScanGate.failIfComparedSecret === secret) {
        throw new Error("Basic auth unexpectedly entered the legacy bcrypt scan");
      }
      if (slowScanGate.secret === secret && slowScanGate.waitForRelease) {
        const entered = slowScanGate.entered;
        const waitForRelease = slowScanGate.waitForRelease;
        slowScanGate.secret = null;
        slowScanGate.entered = null;
        slowScanGate.waitForRelease = null;
        entered?.();
        await waitForRelease;
      }
      return actual.compare(secret, hash);
    },
  };
});

const GATEWAY_DB = "/tmp/peri-gateway-legacy-bearer.db";
const SHARED_DB = "/tmp/peri-gateway-legacy-bearer-shared.db";
const TEST_SALT = "legacy-bearer-test-salt";
const PROJECT_ID = "project-legacy-bearer";
const PROJECT_SECRET = "sk-legacy-project-target";
const ORGANIZATION_SECRET = "sk-legacy-organization-target";
const EXPIRED_SECRET = "sk-legacy-expired-target";
const MODERN_BCRYPT_ONLY_SECRET = "sk-modern-bcrypt-only";

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}

function fastHash(secretKey: string): string {
  return createHash("sha256")
    .update(secretKey)
    .update(createHash("sha256").update(TEST_SALT, "utf8").digest("hex"))
    .digest("hex");
}

function seedSharedApiKeys(): void {
  const db = new DatabaseSync(SHARED_DB);
  db.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      hashed_secret_key TEXT NOT NULL UNIQUE,
      fast_hashed_secret_key TEXT UNIQUE,
      project_id TEXT,
      organization_id TEXT,
      scope TEXT NOT NULL DEFAULT 'PROJECT',
      expires_at TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO api_keys (
      id, public_key, hashed_secret_key, fast_hashed_secret_key,
      project_id, organization_id, scope, expires_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
  `);

  db.prepare(`
    INSERT INTO api_keys (
      id, public_key, hashed_secret_key, fast_hashed_secret_key,
      project_id, organization_id, scope, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'PROJECT', NULL)
  `).run(
    "modern-mismatched-fast-hash",
    "pk-modern-mismatched-fast-hash",
    bcrypt.hashSync(MODERN_BCRYPT_ONLY_SECRET, 4),
    fastHash("sk-different-modern-secret"),
    PROJECT_ID,
    "org-legacy-bearer",
  );

  for (let index = 0; index < 100; index += 1) {
    const suffix = index.toString().padStart(3, "0");
    insert.run(
      `legacy-${suffix}`,
      `pk-legacy-${suffix}`,
      bcrypt.hashSync(`sk-legacy-decoy-${suffix}`, 4),
      PROJECT_ID,
      "org-legacy-bearer",
      "PROJECT",
      null,
    );
  }

  insert.run(
    "legacy-target-expired",
    "pk-legacy-expired-target",
    bcrypt.hashSync(EXPIRED_SECRET, 4),
    PROJECT_ID,
    "org-legacy-bearer",
    "PROJECT",
    "2000-01-01T00:00:00.000Z",
  );
  insert.run(
    "legacy-target-organization",
    "pk-legacy-organization-target",
    bcrypt.hashSync(ORGANIZATION_SECRET, 4),
    null,
    "org-legacy-bearer",
    "ORGANIZATION",
    null,
  );
  insert.run(
    "legacy-target-project",
    "pk-legacy-project-target",
    bcrypt.hashSync(PROJECT_SECRET, 4),
    PROJECT_ID,
    "org-legacy-bearer",
    "PROJECT",
    null,
  );
  db.close();
}

async function createAuthProbe(): Promise<Hono<GatewayEnv>> {
  const { unifiedAuth } = await import("../src/middleware/auth.js");
  const probe = new Hono<GatewayEnv>();
  probe.use("/probe", unifiedAuth);
  probe.get("/probe", (c) =>
    c.json({ projectId: c.get("projectId"), publicKey: c.get("apiKeyId") }),
  );
  return probe;
}

describe("Gateway legacy Bearer authentication", () => {
  let probe: Hono<GatewayEnv>;

  beforeAll(async () => {
    removeSqliteFiles(GATEWAY_DB);
    removeSqliteFiles(SHARED_DB);
    process.env.GATEWAY_DB_URL = `file:${GATEWAY_DB}`;
    process.env.DATABASE_URL = `file:${SHARED_DB}`;
    process.env.SALT = TEST_SALT;
    process.env.GATEWAY_ENCRYPTION_KEY = "a".repeat(64);
    seedSharedApiKeys();

    const { ensureSchema } = await import("../src/db.js");
    ensureSchema();
    probe = await createAuthProbe();
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db.js");
    closeDb();
  });

  it("fails closed when another legacy bcrypt scan is already running", async () => {
    let notifyEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    let releaseScan: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    slowScanGate.secret = "sk-controlled-slow-scan";
    slowScanGate.entered = notifyEntered;
    slowScanGate.waitForRelease = released;

    const firstRequest = probe.request("/probe", {
      headers: { Authorization: "Bearer sk-controlled-slow-scan" },
    });
    await entered;
    const saturated = await probe.request("/probe", {
      headers: { Authorization: "Bearer sk-second-concurrent-scan" },
    });
    releaseScan();
    const firstResponse = await firstRequest;

    expect(saturated.status).toBe(503);
    expect(saturated.headers.get("Retry-After")).toBe("1");
    expect(await saturated.json()).toEqual({
      error: {
        message: "Legacy API key verification is busy. Retry shortly.",
        type: "service_unavailable_error",
      },
    });
    expect(firstResponse.status).toBe(401);
  });

  it("rejects a missing Basic public key without entering a busy legacy scan", async () => {
    let notifyEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    let releaseScan: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    slowScanGate.secret = "sk-controlled-basic-isolation-scan";
    slowScanGate.entered = notifyEntered;
    slowScanGate.waitForRelease = released;

    const firstRequest = probe.request("/probe", {
      headers: { Authorization: "Bearer sk-controlled-basic-isolation-scan" },
    });
    await entered;

    const missingSecret = "sk-missing-basic-key";
    slowScanGate.failIfComparedSecret = missingSecret;
    let response: Response;
    try {
      response = await probe.request("/probe", {
        headers: {
          Authorization: `Basic ${Buffer.from(`pk-missing:${missingSecret}`).toString("base64")}`,
        },
      });
    } finally {
      slowScanGate.failIfComparedSecret = null;
      releaseScan();
    }
    const firstResponse = await firstRequest;

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "Invalid API key", type: "authentication_error" },
    });
    expect(firstResponse.status).toBe(401);
  });

  it("authenticates a legacy Bearer key beyond the first 100 rows", async () => {
    const response = await probe.request("/probe", {
      headers: { Authorization: `Bearer ${PROJECT_SECRET}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: PROJECT_ID,
      publicKey: "pk-legacy-project-target",
    });

    const shared = new DatabaseSync(SHARED_DB);
    const row = shared
      .prepare("SELECT fast_hashed_secret_key FROM api_keys WHERE id = 'legacy-target-project'")
      .get() as { fast_hashed_secret_key: string };
    expect(row.fast_hashed_secret_key).toBe(fastHash(PROJECT_SECRET));
    shared
      .prepare("UPDATE api_keys SET hashed_secret_key = ? WHERE id = 'legacy-target-project'")
      .run(bcrypt.hashSync("no-longer-matching", 4));
    shared.close();

    const { closeDb } = await import("../src/db.js");
    closeDb();
    vi.resetModules();
    const { ensureSchema } = await import("../src/db.js");
    ensureSchema();
    probe = await createAuthProbe();

    const fastPathResponse = await probe.request("/probe", {
      headers: { Authorization: `Bearer ${PROJECT_SECRET}` },
    });
    expect(fastPathResponse.status).toBe(200);
  });

  it("rejects an invalid Bearer secret after exhausting legacy candidates", async () => {
    const shared = new DatabaseSync(SHARED_DB);
    const before = shared
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE fast_hashed_secret_key IS NOT NULL")
      .get() as { count: number };
    shared.close();

    const response = await probe.request("/probe", {
      headers: { Authorization: "Bearer sk-not-a-real-legacy-key" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "Invalid secret key", type: "authentication_error" },
    });

    const reread = new DatabaseSync(SHARED_DB);
    const after = reread
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE fast_hashed_secret_key IS NOT NULL")
      .get() as { count: number };
    reread.close();
    expect(after.count).toBe(before.count);
  });

  it("does not bcrypt-scan a modern key whose fast hash does not match", async () => {
    const response = await probe.request("/probe", {
      headers: { Authorization: `Bearer ${MODERN_BCRYPT_ONLY_SECRET}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "Invalid secret key", type: "authentication_error" },
    });
  });

  it("rejects an organization-scoped legacy key beyond the first batch", async () => {
    const response = await probe.request("/probe", {
      headers: { Authorization: `Bearer ${ORGANIZATION_SECRET}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        message:
          "Gateway requires a PROJECT-scoped API key. Organization-level keys are not supported.",
        type: "authentication_error",
      },
    });
  });

  it("reports an expired legacy key beyond the first batch", async () => {
    const response = await probe.request("/probe", {
      headers: { Authorization: `Bearer ${EXPIRED_SECRET}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "API key is expired", type: "authentication_error" },
    });
  });
});
