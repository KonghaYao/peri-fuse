import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import { openLocalDatabase as createLocalDatabase } from "@peri-fuse/shared/src/db/local";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { afterAll, beforeAll, expect } from "vitest";

export const TEST_DB = "/tmp/peri-gateway-test.db";

export const SHARED_DB = "/tmp/peri-gateway-shared-test.db";

export const MOCK_PORT = 19876;

export const TEST_SALT = "test-salt-value";

// Project A credentials
export const PROJ_A = "proj-alpha";

export const ORG_A = "org-alpha";

export const PK_A = "pk-alpha-001";

export const SK_A = "sk-alpha-secret-001";

// Project B credentials
export const PROJ_B = "proj-beta";

export const ORG_B = "org-beta";

export const PK_B = "pk-beta-001";

export const SK_B = "sk-beta-secret-001";

// Org-scoped key (should be rejected)
export const PK_ORG = "pk-org-001";

export const SK_ORG = "sk-org-secret-001";

// ─── Mock LLM Server ───────────────────────────────────────────────
export function createMockLLM(): Hono {
  const app = new Hono();

  app.post("/chat/completions", async (c) => {
    const body = await c.req.json();

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        const words = ["Hello", " world"];
        for (const word of words) {
          await stream.writeSSE({
            data: JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
            }),
          });
        }
        await stream.writeSSE({
          data: JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    }

    return c.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  return app;
}

// ─── Helpers ───────────────────────────────────────────────────────
export let mockServer: ServerType;

export let app: Hono<any>;

export let providerIdA: string;

export function bearer(sk: string): string {
  return `Bearer ${sk}`;
}

export function basic(pk: string, sk: string): string {
  return `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`;
}

/** Admin request using project A Bearer token */
export async function adminPostA(path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(SK_A),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function adminGetA(path: string) {
  const res = await app.request(path, {
    headers: { Authorization: bearer(SK_A) },
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Admin request using project B Bearer token */
export async function adminPostB(path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(SK_B),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function adminGetB(path: string) {
  const res = await app.request(path, {
    headers: { Authorization: bearer(SK_B) },
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function proxyPost(path: string, body: unknown, secretKey = SK_A) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(secretKey),
    },
    body: JSON.stringify(body),
  });
  return res;
}

// ─── Setup ─────────────────────────────────────────────────────────
beforeAll(async () => {
  // Clean test databases
  for (const dbPath of [TEST_DB, SHARED_DB]) {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const f = `${dbPath}${suffix}`;
      if (existsSync(f)) unlinkSync(f);
    }
  }

  // Set env before importing app
  process.env.GATEWAY_DB_URL = `file:${TEST_DB}`;
  process.env.DATABASE_URL = `file:${SHARED_DB}`;
  process.env.SALT = TEST_SALT;

  // Create gateway schema
  const { ensureSchema } = await import("../src/db.js");
  await ensureSchema();

  // Create shared DB with api_keys table (includes organization_id + scope)

  const sharedSqlite = await createLocalDatabase(SHARED_DB);
  await sharedSqlite.exec(`
    CREATE TABLE IF NOT EXISTS _perifuse_migrations(name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      hashed_secret_key TEXT NOT NULL,
      fast_hashed_secret_key TEXT,
      project_id TEXT,
      organization_id TEXT,
      scope TEXT DEFAULT 'PROJECT',
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  function makeFastHash(sk: string): string {
    return createHash("sha256")
      .update(sk)
      .update(createHash("sha256").update(TEST_SALT, "utf8").digest("hex"))
      .digest("hex");
  }

  // Seed Project A key
  await sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope)
    VALUES ('key-a', '${PK_A}', '${bcrypt.hashSync(SK_A, 10)}', '${makeFastHash(SK_A)}', '${PROJ_A}', '${ORG_A}', 'PROJECT');
  `);

  // Seed Project B key
  await sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope)
    VALUES ('key-b', '${PK_B}', '${bcrypt.hashSync(SK_B, 10)}', '${makeFastHash(SK_B)}', '${PROJ_B}', '${ORG_B}', 'PROJECT');
  `);

  // Seed Org-scoped key (should be rejected by gateway)
  await sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope)
    VALUES ('key-org', '${PK_ORG}', '${bcrypt.hashSync(SK_ORG, 10)}', '${makeFastHash(SK_ORG)}', NULL, '${ORG_A}', 'ORGANIZATION');
  `);

  await sharedSqlite.close();

  // Start mock LLM server
  const mockApp = createMockLLM();
  await new Promise<void>((resolve) => {
    mockServer = serve({ fetch: mockApp.fetch, port: MOCK_PORT }, () => resolve());
  });

  // Import and create gateway app
  const { createApp } = await import("../src/app.js");
  const { spendFlusher } = await import("../src/spend/flusher.js");

  app = createApp();
  spendFlusher.start();

  // Seed Project A: provider → deployment → key config
  const provRes = await adminPostA("/admin/providers", {
    name: "provider-alpha",
    type: "openai",
    baseUrl: `http://localhost:${MOCK_PORT}`,
    apiKey: "mock-key-a",
  });
  expect(provRes.status).toBe(201);
  providerIdA = provRes.body.id;

  const depRes = await adminPostA("/admin/models", {
    modelName: "gpt-test",
    providerId: providerIdA,
    providerModel: "gpt-test-real",
    modelInfo: { inputPrice: 0.001, outputPrice: 0.002 },
  });
  expect(depRes.status).toBe(201);

  const keyRes = await adminPostA("/admin/keys", {
    publicKey: PK_A,
    keyName: "alpha-main",
    rpmLimit: 100,
    maxBudget: 10.0,
  });
  expect(keyRes.status).toBe(201);
});

afterAll(async () => {
  const { spendFlusher } = await import("../src/spend/flusher.js");
  const { closeDb } = await import("../src/db.js");
  spendFlusher.stop();
  await spendFlusher.flushAll();
  await closeDb();
  await mockServer?.close();
});
