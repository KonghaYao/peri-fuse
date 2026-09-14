import { randomUUID } from "node:crypto";
import { prisma } from "@peri-fuse/shared/src/db";
import { apiKeys } from "@peri-fuse/shared/src/db/schema/index.js";
import { createShaHash, hashSecretKey } from "@peri-fuse/shared/src/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { basicAuth, getApp } from "./helpers";
import { createSecondProject } from "./second-project";
import { TEST_ORG_ID, TEST_PUBLIC_KEY, TEST_SALT, TEST_SECRET_KEY } from "./test-db-paths";

const PROTOCOL_VERSION = "2026-07-28";
const SKILL_URI = "skill://langfuse/SKILL.md";

type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  auth: string | null = basicAuth(),
  path = "/mcp",
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: JsonRpcResponse | Record<string, unknown> | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": method,
    ...extraHeaders,
  };
  if (auth) headers.Authorization = auth;
  if (typeof params.uri === "string") headers["Mcp-Name"] = params.uri;
  const response = await getApp().request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "peri-fuse-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe("MCP mounted on the lite server", () => {
  let organizationAuth: string;

  beforeAll(async () => {
    const publicKey = `pk-org-mcp-${randomUUID()}`;
    const secretKey = `sk-org-mcp-${randomUUID()}`;
    await prisma.insert(apiKeys).values({
      id: randomUUID(),
      publicKey,
      hashedSecretKey: await hashSecretKey(secretKey),
      fastHashedSecretKey: createShaHash(secretKey, TEST_SALT),
      displaySecretKey: `${secretKey.slice(0, 10)}...`,
      organizationId: TEST_ORG_ID,
      projectId: null,
      scope: "ORGANIZATION",
    });
    organizationAuth = basicAuth(publicKey, secretKey);
  });

  it.each([
    ["without credentials", null],
    ["with invalid credentials", basicAuth("pk-mcp-nope", "sk-mcp-nope")],
  ])("rejects MCP access %s", async (_label, auth) => {
    const response = await mcpRequest("server/discover", {}, auth);
    expect(response.status).toBe(401);
  });

  it("rejects organization-scoped API keys", async () => {
    const response = await mcpRequest("server/discover", {}, organizationAuth);
    expect(response.status).toBe(403);
    expect((response.body as Record<string, unknown>).message).toContain("organization key");
  });

  it("performs modern protocol discovery", async () => {
    const response = await mcpRequest("server/discover");
    expect(response.status).toBe(200);
    const result = (response.body as JsonRpcResponse).result;
    expect(result?._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": { name: "langfuse-mcp", version: "0.1.0" },
    });
    expect(result?.supportedVersions).toContain(PROTOCOL_VERSION);
  });

  it("rejects the legacy initialize handshake on the strict endpoint", async () => {
    const response = await getApp().request("/mcp", {
      method: "POST",
      headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.message).toContain("2025-11-25");
  });

  it("lists and reads real skill resources", async () => {
    const listed = await mcpRequest("resources/list");
    expect(listed.status).toBe(200);
    const resources = (listed.body as JsonRpcResponse).result?.resources as Array<{ uri: string }>;
    expect(resources.some((resource) => resource.uri === SKILL_URI)).toBe(true);
    expect(
      resources.some((resource) => resource.uri === "skill://langfuse/references/cli.md"),
    ).toBe(true);

    const read = await mcpRequest("resources/read", { uri: SKILL_URI });
    expect(read.status).toBe(200);
    const contents = (read.body as JsonRpcResponse).result?.contents as Array<{
      text?: string;
      mimeType?: string;
    }>;
    expect(contents[0]?.mimeType).toBe("text/markdown");
    expect(contents[0]?.text).toContain("Langfuse");
  });

  it("returns a protocol error for an unknown resource URI", async () => {
    const response = await mcpRequest("resources/read", {
      uri: "skill://langfuse/does-not-exist.md",
    });
    expect(response.status).toBe(200);
    expect((response.body as JsonRpcResponse).error).toMatchObject({ code: -32602 });
  });

  it("rejects path traversal resource URIs", async () => {
    const response = await mcpRequest("resources/read", {
      uri: "skill://langfuse/references/%2E%2E%2FSKILL.md",
    });
    expect(response.status).toBe(200);
    expect((response.body as JsonRpcResponse).error?.code).toBe(-32602);
  });

  it("keeps project credentials out of resources read by another project", async () => {
    const projectB = await createSecondProject();
    const response = await mcpRequest("resources/read", { uri: SKILL_URI }, projectB.auth);
    expect(response.status).toBe(200);
    const contents = (response.body as JsonRpcResponse).result?.contents as Array<{
      text?: string;
    }>;
    const text = contents[0]?.text ?? "";
    expect(text).not.toContain(TEST_PUBLIC_KEY);
    expect(text).not.toContain(TEST_SECRET_KEY);
    expect(text).not.toContain(projectB.auth);
  });

  it("does not expose resources without the authenticated project request", async () => {
    const response = await mcpRequest("resources/list", {}, null);
    expect(response.status).toBe(401);
  });

  it("enforces request limits and JSON 404 semantics on the MCP mount", async () => {
    const oversized = await mcpRequest("server/discover", {}, basicAuth(), "/mcp", {
      "Content-Length": String(17 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);

    const unmatched = await getApp().request("/mcp/unknown", {
      method: "POST",
      headers: { Authorization: basicAuth(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unmatched.status).toBe(404);
    expect(await unmatched.json()).toEqual({ message: "Not Found" });
  });

  it("counts a request only once when the active-request limit is one", async () => {
    const previousLimit = process.env.LITE_MAX_ACTIVE_REQUESTS;
    process.env.LITE_MAX_ACTIVE_REQUESTS = "1";
    const app = createApp();
    try {
      const response = await app.request("/mcp", {
        method: "GET",
        headers: { Authorization: basicAuth() },
      });
      // Reaching the protocol's method rejection proves the shared capacity
      // middleware did not reject this single request as a second active one.
      expect(response.status).toBe(405);
      await response.text();
    } finally {
      await app.close();
      if (previousLimit === undefined) delete process.env.LITE_MAX_ACTIVE_REQUESTS;
      else process.env.LITE_MAX_ACTIVE_REQUESTS = previousLimit;
    }
  });

  it("rejects unsupported HTTP methods without SPA fallback", async () => {
    const response = await getApp().request("/mcp", {
      method: "GET",
      headers: { Authorization: basicAuth() },
    });
    expect(response.status).toBe(405);
    expect((await response.text()).toLowerCase()).not.toContain("<!doctype html>");
  });

  it("answers MCP CORS preflight with the requested headers", async () => {
    const response = await getApp().request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,mcp-protocol-version,mcp-method,mcp-name",
      },
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    const allowed = response.headers.get("access-control-allow-headers")?.toLowerCase().split(",");
    expect(allowed).toEqual(
      expect.arrayContaining([
        "authorization",
        "content-type",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
      ]),
    );
  });
});
