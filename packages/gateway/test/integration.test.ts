/**
 * PeriGateway integration tests — unified project-scoped auth.
 *
 * Covers user flows:
 *  1. Auth: Bearer / Basic / missing / invalid / org-scope rejection
 *  2. Admin CRUD via project API key (provider → model → key config)
 *  3. Proxy: non-streaming, streaming, anthropic messages
 *  4. Multi-project isolation (project A cannot see project B resources)
 *  5. Rate limiting & budget enforcement
 *  6. Usage & logs visibility
 */
import { serve, type ServerType } from "@hono/node-server";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = "/tmp/peri-gateway-test.db";
const SHARED_DB = "/tmp/peri-gateway-shared-test.db";
const MOCK_PORT = 19876;
const TEST_SALT = "test-salt-value";

// Project A credentials
const PROJ_A = "proj-alpha";
const ORG_A = "org-alpha";
const PK_A = "pk-alpha-001";
const SK_A = "sk-alpha-secret-001";

// Project B credentials
const PROJ_B = "proj-beta";
const ORG_B = "org-beta";
const PK_B = "pk-beta-001";
const SK_B = "sk-beta-secret-001";

// Org-scoped key (should be rejected)
const PK_ORG = "pk-org-001";
const SK_ORG = "sk-org-secret-001";

// ─── Mock LLM Server ───────────────────────────────────────────────
function createMockLLM(): Hono {
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
let mockServer: ServerType;
let app: Hono<any>;
let providerIdA: string;

function bearer(sk: string): string {
  return `Bearer ${sk}`;
}

function basic(pk: string, sk: string): string {
  return `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`;
}

/** Admin request using project A Bearer token */
async function adminPostA(path: string, body: unknown) {
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

async function adminGetA(path: string) {
  const res = await app.request(path, {
    headers: { Authorization: bearer(SK_A) },
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Admin request using project B Bearer token */
async function adminPostB(path: string, body: unknown) {
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

async function adminGetB(path: string) {
  const res = await app.request(path, {
    headers: { Authorization: bearer(SK_B) },
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function proxyPost(path: string, body: unknown, secretKey = SK_A) {
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
  ensureSchema();

  // Create shared DB with api_keys table (includes organization_id + scope)

  const sharedSqlite = new DatabaseSync(SHARED_DB);
  sharedSqlite.exec(`
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
  sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope)
    VALUES ('key-a', '${PK_A}', '${bcrypt.hashSync(SK_A, 10)}', '${makeFastHash(SK_A)}', '${PROJ_A}', '${ORG_A}', 'PROJECT');
  `);

  // Seed Project B key
  sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope)
    VALUES ('key-b', '${PK_B}', '${bcrypt.hashSync(SK_B, 10)}', '${makeFastHash(SK_B)}', '${PROJ_B}', '${ORG_B}', 'PROJECT');
  `);

  // Seed Org-scoped key (should be rejected by gateway)
  sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope)
    VALUES ('key-org', '${PK_ORG}', '${bcrypt.hashSync(SK_ORG, 10)}', '${makeFastHash(SK_ORG)}', NULL, '${ORG_A}', 'ORGANIZATION');
  `);

  sharedSqlite.close();

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
  closeDb();
  mockServer?.close();
});

// ─── Tests ─────────────────────────────────────────────────────────

describe("health", () => {
  it("returns ok without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("peri-gateway");
  });
});

describe("auth: unified project-scoped", () => {
  it("rejects missing Authorization header", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
  });

  it("rejects invalid secret key", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer("sk-totally-invalid") },
    });
    expect(res.status).toBe(401);
  });

  it("accepts Bearer token (project A)", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(SK_A) },
    });
    expect(res.status).toBe(200);
  });

  it("accepts Basic auth (project A)", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: basic(PK_A, SK_A) },
    });
    expect(res.status).toBe(200);
  });

  it("accepts Bearer token (project B)", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(SK_B) },
    });
    expect(res.status).toBe(200);
  });

  it("rejects ORGANIZATION-scoped key with 403", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(SK_ORG) },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("PROJECT-scoped");
  });

  it("admin routes also require auth (no x-admin-key)", async () => {
    const res = await app.request("/admin/providers", {
      headers: { "x-admin-key": "anything" },
    });
    expect(res.status).toBe(401);
  });

  it("admin routes work with project Bearer key", async () => {
    const { status } = await adminGetA("/admin/providers");
    expect(status).toBe(200);
  });
});

describe("proxy: non-streaming chat", () => {
  it("proxies request and returns formatted response", async () => {
    const res = await proxyPost("/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(5);
    expect(body.usage.completion_tokens).toBe(2);
    expect(body.usage.total_tokens).toBe(7);
  });

  it("returns 404 for unknown model", async () => {
    const res = await proxyPost("/v1/chat/completions", {
      model: "nonexistent-model",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.status).toBe(404);
  });
});

describe("proxy: streaming chat", () => {
  it("returns SSE stream with chunks", async () => {
    const res = await proxyPost("/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));

    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[lines.length - 1]).toBe("data: [DONE]");

    const first = JSON.parse(lines[0].slice(6));
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0].delta.content).toBe("Hello");
  });
});

describe("proxy: anthropic messages", () => {
  it("handles /v1/messages endpoint", async () => {
    const res = await proxyPost("/v1/messages", {
      model: "gpt-test",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Hello world");
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(2);
  });
});

describe("models listing", () => {
  it("lists configured models for project A", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(SK_A) },
    });
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.some((m: any) => m.id === "gpt-test")).toBe(true);
  });

  it("project B sees no models (isolation)", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(SK_B) },
    });
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(0);
  });
});

describe("admin: provider CRUD (project A)", () => {
  it("lists providers", async () => {
    const { status, body } = await adminGetA("/admin/providers");
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].name).toBe("provider-alpha");
    expect(body.data[0].apiKeyEncrypted).toBe("***encrypted***");
  });

  it("updates provider", async () => {
    const res = await app.request(`/admin/providers/${providerIdA}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(SK_A),
      },
      body: JSON.stringify({ isEnabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.isEnabled).toBe(false);

    // Re-enable
    await app.request(`/admin/providers/${providerIdA}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(SK_A),
      },
      body: JSON.stringify({ isEnabled: true }),
    });
  });
});

describe("admin: key management", () => {
  it("lists key configs with publicKey", async () => {
    const { status, body } = await adminGetA("/admin/keys");
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].publicKey).toBe(PK_A);
  });
});

describe("multi-project isolation", () => {
  it("project B cannot see project A providers", async () => {
    const { status, body } = await adminGetB("/admin/providers");
    expect(status).toBe(200);
    expect(body.data.length).toBe(0);
  });

  it("project B cannot see project A models", async () => {
    const { status, body } = await adminGetB("/admin/models");
    expect(status).toBe(200);
    expect(body.data.length).toBe(0);
  });

  it("project B cannot see project A keys", async () => {
    const { status, body } = await adminGetB("/admin/keys");
    expect(status).toBe(200);
    expect(body.data.length).toBe(0);
  });

  it("project B can create its own provider independently", async () => {
    const { status, body } = await adminPostB("/admin/providers", {
      name: "provider-beta",
      type: "openai",
      baseUrl: `http://localhost:${MOCK_PORT}`,
      apiKey: "mock-key-b",
    });
    expect(status).toBe(201);
    expect(body.name).toBe("provider-beta");

    // Verify A still only sees its own
    const { body: aProviders } = await adminGetA("/admin/providers");
    expect(aProviders.data.every((p: any) => p.name !== "provider-beta")).toBe(true);
  });

  it("same provider name allowed in different projects", async () => {
    const { status } = await adminPostB("/admin/providers", {
      name: "provider-alpha",
      type: "openai",
      baseUrl: `http://localhost:${MOCK_PORT}`,
      apiKey: "mock-key-dup",
    });
    expect(status).toBe(201);
  });

  it("project B cannot proxy using project A model", async () => {
    const res = await proxyPost(
      "/v1/chat/completions",
      { model: "gpt-test", messages: [{ role: "user", content: "Hi" }] },
      SK_B,
    );
    expect(res.status).toBe(404);
  });
});

describe("admin: usage & logs", () => {
  it("returns usage summary for project A", async () => {
    const { status, body } = await adminGetA("/admin/usage/summary");
    expect(status).toBe(200);
    expect(body.totalRequests).toBeGreaterThanOrEqual(0);
  });

  it("returns request logs after flush", async () => {
    const { spendFlusher } = await import("../src/spend/flusher.js");
    await spendFlusher.flushAll();

    const { status, body } = await adminGetA("/admin/logs/requests?limit=10");
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data[0].status).toBe("success");
    expect(body.data[0].model).toBe("gpt-test-real");
  });

  it("project B logs are empty (isolation)", async () => {
    const { status, body } = await adminGetB("/admin/logs/requests?limit=10");
    expect(status).toBe(200);
    expect(body.total).toBe(0);
  });
});

describe("admin: audit log", () => {
  it("records admin operations for project A", async () => {
    const { status, body } = await adminGetA("/admin/audit?tableName=Provider");
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data[0].action).toBeDefined();
  });
});

describe("rate limiting", () => {
  it("enforces RPM limit", async () => {
    // Seed a rate-limited key in shared DB (project A)
    const sharedSqlite = new DatabaseSync(SHARED_DB);
    const hashed = bcrypt.hashSync("sk-ratelimit", 10);
    sharedSqlite.exec(`
      INSERT OR IGNORE INTO api_keys (id, public_key, hashed_secret_key, project_id, organization_id, scope)
      VALUES ('key-rl', 'pk-ratelimit', '${hashed}', '${PROJ_A}', '${ORG_A}', 'PROJECT');
    `);
    sharedSqlite.close();

    // Create gateway config with low RPM
    await adminPostA("/admin/keys", {
      publicKey: "pk-ratelimit",
      keyName: "rate-limited",
      rpmLimit: 2,
    });

    // First 2 requests should pass
    const r1 = await proxyPost("/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "1" }],
    }, "sk-ratelimit");
    expect(r1.status).toBe(200);

    const r2 = await proxyPost("/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "2" }],
    }, "sk-ratelimit");
    expect(r2.status).toBe(200);

    // Third should be rate limited
    const r3 = await proxyPost("/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "3" }],
    }, "sk-ratelimit");
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as any;
    expect(body.error.message).toContain("Rate limit");
  });
});

describe("budget limiting", () => {
  it("rejects when budget exceeded", async () => {
    // Seed a budget-limited key in shared DB (project A)
    const sharedSqlite = new DatabaseSync(SHARED_DB);
    const hashed = bcrypt.hashSync("sk-budget", 10);
    sharedSqlite.exec(`
      INSERT OR IGNORE INTO api_keys (id, public_key, hashed_secret_key, project_id, organization_id, scope)
      VALUES ('key-bud', 'pk-budget', '${hashed}', '${PROJ_A}', '${ORG_A}', 'PROJECT');
    `);
    sharedSqlite.close();

    // Create gateway config with tiny budget
    await adminPostA("/admin/keys", {
      publicKey: "pk-budget",
      keyName: "budget-limited",
      maxBudget: 0.0000001,
    });

    // Manually set spend above budget
    const { getDb } = await import("../src/db.js");
    const { apiKey } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    await db.update(apiKey).set({ spend: 1.0 }).where(eq(apiKey.publicKey, "pk-budget"));

    const res = await proxyPost("/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "Hi" }],
    }, "sk-budget");
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Budget");
  });
});

describe("user flow: full lifecycle", () => {
  it("project B: setup provider → deploy model → proxy call → verify logs", async () => {
    // 1. Create provider
    const provRes = await adminPostB("/admin/providers", {
      name: "lifecycle-provider",
      type: "openai",
      baseUrl: `http://localhost:${MOCK_PORT}`,
      apiKey: "lifecycle-key",
    });
    expect(provRes.status).toBe(201);
    const provId = provRes.body.id;

    // 2. Deploy model
    const depRes = await adminPostB("/admin/models", {
      modelName: "lifecycle-model",
      providerId: provId,
      providerModel: "lifecycle-real",
      modelInfo: { inputPrice: 0.01, outputPrice: 0.02 },
    });
    expect(depRes.status).toBe(201);

    // 3. Proxy call with project B key
    const chatRes = await proxyPost("/v1/chat/completions", {
      model: "lifecycle-model",
      messages: [{ role: "user", content: "lifecycle test" }],
    }, SK_B);
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as any;
    expect(chatBody.choices[0].message.content).toBe("Hello world");

    // 4. Flush and verify logs
    const { spendFlusher } = await import("../src/spend/flusher.js");
    await spendFlusher.flushAll();

    const { status, body } = await adminGetB("/admin/logs/requests?limit=10");
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data[0].model).toBe("lifecycle-real");

    // 5. Project A still cannot see B's logs
    const { body: aLogs } = await adminGetA("/admin/logs/requests?limit=50");
    expect(aLogs.data.every((l: any) => l.model !== "lifecycle-real")).toBe(true);
  });
});
