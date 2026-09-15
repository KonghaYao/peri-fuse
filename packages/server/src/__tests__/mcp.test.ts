import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { getApp } from "./helpers";
import { TEST_PUBLIC_KEY, TEST_SECRET_KEY } from "./test-db-paths";

const PROTOCOL_VERSION = "2026-07-28";
const SKILL_URI = "skill://langfuse/SKILL.md";

type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
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
  expect(response.headers.get("www-authenticate")).toBeNull();
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe("MCP mounted on the lite server", () => {
  it("performs anonymous modern protocol discovery", async () => {
    const response = await mcpRequest("server/discover");
    expect(response.status).toBe(200);
    const result = (response.body as JsonRpcResponse).result;
    expect(result?._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": { name: "langfuse-mcp", version: "0.1.0" },
    });
    expect(result?.supportedVersions).toContain(PROTOCOL_VERSION);
  });

  it("supports anonymous legacy initialize and stateless resource reads", async () => {
    async function legacy(method: string, params: Record<string, unknown> = {}) {
      const response = await getApp().request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("www-authenticate")).toBeNull();
      const text = await response.text();
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim()
        : text;
      expect(data).toBeTruthy();
      return JSON.parse(data ?? "") as JsonRpcResponse;
    }
    const initialized = await legacy("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.result?.protocolVersion).toBe("2025-11-25");
    const listed = await legacy("resources/list");
    expect(listed.result?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: SKILL_URI })]),
    );
    const read = await legacy("resources/read", { uri: SKILL_URI });
    expect(read.result?.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: SKILL_URI, text: expect.stringContaining("Langfuse") }),
      ]),
    );
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

  it("does not expose credentials in static resources", async () => {
    const response = await mcpRequest("resources/read", { uri: SKILL_URI });
    const contents = (response.body as JsonRpcResponse).result?.contents as Array<{
      text?: string;
    }>;
    const text = contents[0]?.text ?? "";
    expect(text).not.toContain(TEST_PUBLIC_KEY);
    expect(text).not.toContain(TEST_SECRET_KEY);
  });

  it("keeps the public API authentication boundary", async () => {
    const response = await getApp().request("/api/public/traces");
    expect(response.status).toBe(401);
  });

  it.each(["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"])(
    "does not expose removed OAuth discovery endpoint %s",
    async (path) => {
      const response = await getApp().request(path, { headers: { Accept: "application/json" } });
      expect(response.status).toBe(404);
      expect(response.headers.get("www-authenticate")).toBeNull();
    },
  );

  it("does not expose removed OAuth registration endpoint", async () => {
    const response = await getApp().request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });

  it("enforces request limits and JSON 404 semantics on the MCP mount", async () => {
    const oversized = await mcpRequest("server/discover", {}, "/mcp", {
      "Content-Length": String(17 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);

    const unmatched = await getApp().request("/mcp/unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  it("returns an API response when opened by a browser", async () => {
    const response = await getApp().request("/mcp", {
      headers: { Accept: "text/html" },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("returns JSON instead of the SPA for the retired MCP path", async () => {
    const response = await getApp().request("/api/mcp");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Not Found" });
  });

  it("rejects unsupported HTTP methods without SPA fallback", async () => {
    const response = await getApp().request("/mcp", {
      method: "GET",
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
