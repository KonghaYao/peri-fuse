/**
 * PeriGateway integration tests.
 *
 * Tests the full proxy flow in-process using app.request() with a real
 * mock LLM backend server for outbound provider calls.
 * Auth uses Bearer token (secretKey only) verified against a shared DB.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, unlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = "/tmp/peri-gateway-test.db";
const SHARED_DB = "/tmp/peri-gateway-shared-test.db";
const MOCK_PORT = 19876;
const ADMIN_KEY = "test-admin-key";
const TEST_PUBLIC_KEY = "pk-test-001";
const TEST_SECRET_KEY = "sk-test-secret-001";
const TEST_SALT = "test-salt-value";

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

// ─── Test Setup ────────────────────────────────────────────────────
let mockServer: ServerType;
let app: Hono<any>;
let providerId: string;

function bearer(secretKey: string): string {
  return `Bearer ${secretKey}`;
}

async function adminPost(path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN_KEY,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function adminGet(path: string) {
  const res = await app.request(path, {
    headers: { "x-admin-key": ADMIN_KEY },
  });
  return { status: res.status, body: await res.json() as any };
}

async function proxyPost(path: string, body: unknown, secretKey = TEST_SECRET_KEY) {
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
  process.env.GATEWAY_ADMIN_KEY = ADMIN_KEY;

  // Create gateway schema (drizzle migration SQL)
  const { ensureSchema } = await import("../src/db.js");
  ensureSchema();

  // Create shared DB with api_keys table and seed a test key
  const { hashSync } = await import("bcryptjs");
  const { createHash } = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");

  const sharedSqlite = new DatabaseSync(SHARED_DB);
  sharedSqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      hashed_secret_key TEXT NOT NULL,
      fast_hashed_secret_key TEXT,
      project_id TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const hashedSecret = hashSync(TEST_SECRET_KEY, 10);
  const fastHash = createHash("sha256")
    .update(TEST_SECRET_KEY)
    .update(createHash("sha256").update(TEST_SALT, "utf8").digest("hex"))
    .digest("hex");

  sharedSqlite.exec(`
    INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id)
    VALUES ('key-1', '${TEST_PUBLIC_KEY}', '${hashedSecret}', '${fastHash}', 'proj-1');
  `);
  sharedSqlite.close();

  // Start mock LLM server
  const mockApp = createMockLLM();
  await new Promise<void>((resolve) => {
    mockServer = serve({ fetch: mockApp.fetch, port: MOCK_PORT }, () => resolve());
  });

  // Import and create gateway app (after env is set)
  const { createApp } = await import("../src/app.js");
  const { spendFlusher } = await import("../src/spend/flusher.js");

  app = createApp();
  spendFlusher.start();

  // Seed: create provider → deployment → key config
  const provRes = await adminPost("/admin/providers", {
    name: "test-provider",
    type: "openai",
    baseUrl: `http://localhost:${MOCK_PORT}`,
    apiKey: "mock-key",
  });
  expect(provRes.status).toBe(201);
  providerId = provRes.body.id;

  const depRes = await adminPost("/admin/models", {
    modelName: "test-model",
    providerId,
    providerModel: "test-model-real",
    modelInfo: { inputPrice: 0.001, outputPrice: 0.002 },
  });
  expect(depRes.status).toBe(201);

  const keyRes = await adminPost("/admin/keys", {
    publicKey: TEST_PUBLIC_KEY,
    keyName: "integration-test",
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
  it("returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("peri-gateway");
  });
});

describe("auth", () => {
  it("rejects missing key", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
  });

  it("rejects invalid credentials", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer("sk-invalid") },
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid Bearer secret key", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(TEST_SECRET_KEY) },
    });
    expect(res.status).toBe(200);
  });

  it("rejects bad admin key", async () => {
    const res = await app.request("/admin/providers", {
      headers: { "x-admin-key": "wrong" },
    });
    expect(res.status).toBe(401);
  });
});

describe("proxy: non-streaming chat", () => {
  it("proxies request and returns formatted response", async () => {
    const res = await proxyPost("/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
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
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));

    // Should have content chunks + [DONE]
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[lines.length - 1]).toBe("data: [DONE]");

    // First chunk should have content
    const first = JSON.parse(lines[0].slice(6));
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0].delta.content).toBe("Hello");
  });
});

describe("proxy: anthropic messages", () => {
  it("handles /v1/messages endpoint", async () => {
    const res = await proxyPost("/v1/messages", {
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Hello world");
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(2);
  });
});

describe("models", () => {
  it("lists configured models", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: bearer(TEST_SECRET_KEY) },
    });
    const body = await res.json() as any;
    expect(body.object).toBe("list");
    expect(body.data.some((m: any) => m.id === "test-model")).toBe(true);
  });
});

describe("admin: provider CRUD", () => {
  it("lists providers", async () => {
    const { status, body } = await adminGet("/admin/providers");
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].name).toBe("test-provider");
    expect(body.data[0].apiKeyEncrypted).toBe("***encrypted***");
  });

  it("updates provider", async () => {
    const res = await app.request(`/admin/providers/${providerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({ isEnabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.isEnabled).toBe(false);

    // Re-enable
    await app.request(`/admin/providers/${providerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({ isEnabled: true }),
    });
  });
});

describe("admin: key management", () => {
  it("lists key configs with publicKey", async () => {
    const { status, body } = await adminGet("/admin/keys");
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].publicKey).toBe(TEST_PUBLIC_KEY);
  });
});

describe("admin: usage & logs", () => {
  it("returns usage summary", async () => {
    const { status, body } = await adminGet("/admin/usage/summary");
    expect(status).toBe(200);
    expect(body.totalRequests).toBeGreaterThanOrEqual(0);
  });

  it("returns request logs after flush", async () => {
    // Wait for flusher
    const { spendFlusher } = await import("../src/spend/flusher.js");
    await spendFlusher.flushAll();

    const { status, body } = await adminGet("/admin/logs/requests?limit=10");
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data[0].status).toBe("success");
    expect(body.data[0].model).toBe("test-model-real");
  });
});

describe("admin: audit log", () => {
  it("records admin operations", async () => {
    const { status, body } = await adminGet("/admin/audit?tableName=Provider");
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data[0].action).toBeDefined();
  });
});

describe("rate limiting", () => {
  it("enforces RPM limit", async () => {
    // Seed a second key in shared DB for rate limit testing
    const { DatabaseSync } = await import("node:sqlite");
    const { hashSync } = await import("bcryptjs");
    const sharedSqlite = new DatabaseSync(SHARED_DB);
    const hashed = hashSync("sk-ratelimit", 10);
    sharedSqlite.exec(`
      INSERT OR IGNORE INTO api_keys (id, public_key, hashed_secret_key, project_id)
      VALUES ('key-rl', 'pk-ratelimit', '${hashed}', 'proj-1');
    `);
    sharedSqlite.close();

    // Create gateway config with low RPM
    await adminPost("/admin/keys", {
      publicKey: "pk-ratelimit",
      keyName: "rate-limited",
      rpmLimit: 2,
    });

    // First 2 requests should pass
    const r1 = await proxyPost("/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "1" }],
    }, "sk-ratelimit");
    expect(r1.status).toBe(200);

    const r2 = await proxyPost("/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "2" }],
    }, "sk-ratelimit");
    expect(r2.status).toBe(200);

    // Third should be rate limited
    const r3 = await proxyPost("/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "3" }],
    }, "sk-ratelimit");
    expect(r3.status).toBe(429);
    const body = await r3.json() as any;
    expect(body.error.message).toContain("Rate limit");
  });
});

describe("budget limiting", () => {
  it("rejects when budget exceeded", async () => {
    // Seed a key in shared DB for budget testing
    const { DatabaseSync } = await import("node:sqlite");
    const { hashSync } = await import("bcryptjs");
    const sharedSqlite = new DatabaseSync(SHARED_DB);
    const hashed = hashSync("sk-budget", 10);
    sharedSqlite.exec(`
      INSERT OR IGNORE INTO api_keys (id, public_key, hashed_secret_key, project_id)
      VALUES ('key-bud', 'pk-budget', '${hashed}', 'proj-1');
    `);
    sharedSqlite.close();

    // Create gateway config with tiny budget
    await adminPost("/admin/keys", {
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
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    }, "sk-budget");
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.message).toContain("Budget");
  });
});
