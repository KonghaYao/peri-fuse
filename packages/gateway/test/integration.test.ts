import { openLocalDatabase as createLocalDatabase } from "@peri-fuse/shared/src/db/local";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  adminGetA,
  adminGetB,
  adminPostA,
  adminPostB,
  app,
  basic,
  bearer,
  MOCK_PORT,
  ORG_A,
  PK_A,
  PROJ_A,
  providerIdA,
  proxyPost,
  SHARED_DB,
  SK_A,
  SK_B,
  SK_ORG,
} from "./integration-fixture";

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
    const sharedSqlite = await createLocalDatabase(SHARED_DB);
    const hashed = bcrypt.hashSync("sk-ratelimit", 10);
    await sharedSqlite.exec(`
      INSERT OR IGNORE INTO api_keys (id, public_key, hashed_secret_key, project_id, organization_id, scope)
      VALUES ('key-rl', 'pk-ratelimit', '${hashed}', '${PROJ_A}', '${ORG_A}', 'PROJECT');
    `);
    await sharedSqlite.close();

    // Create gateway config with low RPM
    await adminPostA("/admin/keys", {
      publicKey: "pk-ratelimit",
      keyName: "rate-limited",
      rpmLimit: 2,
    });

    // First 2 requests should pass
    const r1 = await proxyPost(
      "/v1/chat/completions",
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "1" }],
      },
      "sk-ratelimit",
    );
    expect(r1.status).toBe(200);

    const r2 = await proxyPost(
      "/v1/chat/completions",
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "2" }],
      },
      "sk-ratelimit",
    );
    expect(r2.status).toBe(200);

    // Third should be rate limited
    const r3 = await proxyPost(
      "/v1/chat/completions",
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "3" }],
      },
      "sk-ratelimit",
    );
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as any;
    expect(body.error.message).toContain("Rate limit");
  });
});

describe("budget limiting", () => {
  it("rejects when budget exceeded", async () => {
    // Seed a budget-limited key in shared DB (project A)
    const sharedSqlite = await createLocalDatabase(SHARED_DB);
    const hashed = bcrypt.hashSync("sk-budget", 10);
    await sharedSqlite.exec(`
      INSERT OR IGNORE INTO api_keys (id, public_key, hashed_secret_key, project_id, organization_id, scope)
      VALUES ('key-bud', 'pk-budget', '${hashed}', '${PROJ_A}', '${ORG_A}', 'PROJECT');
    `);
    await sharedSqlite.close();

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

    const res = await proxyPost(
      "/v1/chat/completions",
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "Hi" }],
      },
      "sk-budget",
    );
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
    const chatRes = await proxyPost(
      "/v1/chat/completions",
      {
        model: "lifecycle-model",
        messages: [{ role: "user", content: "lifecycle test" }],
      },
      SK_B,
    );
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
