import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { basicAuth } from "./helpers";

const INDEX = "<!doctype html><html><body>test spa</body></html>";
const APP_JS = "console.log('test app');";
// Read the independently maintained UI routes so adding a page without
// updating the server navigation boundary fails this regression test.
const webRoutes = readFileSync(resolve(__dirname, "../../../web/src/App.tsx"), "utf8");
const pagePaths = [
  "/",
  ...[...webRoutes.matchAll(/path="([^"*]+)"/g)].map(
    (match) => `/${match[1].replace(/:[^/]+/g, "test-id")}`,
  ),
];

describe("SPA fallback route boundaries", () => {
  let webDist: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    webDist = await mkdtemp(join(tmpdir(), "peri-fuse-spa-"));
    await mkdir(join(webDist, "assets"));
    await mkdir(join(webDist, "assets", "v1.0"));
    await writeFile(join(webDist, "index.html"), INDEX);
    await writeFile(join(webDist, "assets", "app.js"), APP_JS);
    await writeFile(join(webDist, "assets", "v1.0", "index.html"), "nested index");
    app = createApp({ webDist });
  });

  afterAll(async () => {
    await app.close();
    await rm(webDist, { recursive: true, force: true });
  });

  async function request(path: string, accept?: string, method = "GET", auth?: string) {
    const headers: Record<string, string> = {};
    if (accept) headers.Accept = accept;
    if (auth) headers.Authorization = auth;
    const response = await app.request(path, { method, headers });
    return { response, body: await response.text() };
  }

  it.each(pagePaths)("serves the index for known HTML page %s", async (path) => {
    const { response, body } = await request(path, "text/html");
    expect(response.status).toBe(200);
    expect(body).toBe(INDEX);
  });

  it("serves a known page for HEAD without a response body", async () => {
    const { response, body } = await request("/dashboard", "text/html", "HEAD");
    expect(response.status).toBe(200);
    expect(body).toBe("");
  });

  it.each([
    ["/", "application/json"],
    ["/dashboard", "application/json"],
    ["/dashboard", "text/html;q=0, application/json"],
    ["/unknown-page", "text/html"],
    ["/assets/missing.js", "text/html"],
    ["/assets/v1.0", "application/json"],
    ["/assets/", "application/json"],
    ["/.well-known/openid-configuration", "text/html"],
    ["/index.html", "application/json"],
    ["/api", "text/html"],
    ["/api/unknown", "text/html"],
  ])("returns JSON 404 for reserved or unknown route %s with Accept %s", async (path, accept) => {
    const { response, body } = await request(path, accept);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toBe(JSON.stringify({ message: "Not Found" }));
  });

  it("returns JSON 404 for an authenticated unknown v1 route", async () => {
    const { response, body } = await request("/v1/unknown", "text/html", "GET", basicAuth());
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toBe(JSON.stringify({ message: "Not Found" }));
  });

  it.each([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("returns JSON 404 for unsupported OAuth discovery %s", async (path) => {
    const { response, body } = await request(path, "text/html");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).not.toContain("<!doctype html>");
  });

  it("keeps v1 authentication ahead of unknown route handling", async () => {
    const { response, body } = await request("/v1/unknown", "text/html");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).not.toContain("<!doctype html>");
  });

  it("does not assume HTML when Accept is absent", async () => {
    const { response, body } = await request("/dashboard");
    expect(response.status).toBe(404);
    expect(body).toBe(JSON.stringify({ message: "Not Found" }));
  });

  it.each(["/", "/dashboard", "/traces/trace-123", "/sessions/session-123", "/gateway/models"])(
    "does not serve HTML for POST to known UI route %s",
    async (path) => {
      const { response, body } = await request(path, "text/html", "POST");
      expect(response.status).toBe(404);
      expect(body).toBe(JSON.stringify({ message: "Not Found" }));
    },
  );

  it("does not serve the SPA for the reserved OAuth endpoint with a legacy MCP header", async () => {
    const response = await app.request("/.well-known/oauth-authorization-server", {
      headers: {
        Accept: "application/json",
        "MCP-Protocol-Version": "2025-11-25",
      },
    });
    expect(response.status).toBe(404);
    expect((await response.text()).toLowerCase()).not.toContain("<!doctype html>");
  });

  it("serves real static files regardless of HTML Accept", async () => {
    const { response, body } = await request("/assets/app.js", "text/html");
    expect(response.status).toBe(200);
    expect(body).toBe(APP_JS);
  });

  it("does not turn the MCP endpoint into an HTML fallback", async () => {
    const { response, body } = await request("/mcp", "text/html");
    expect(response.status).not.toBe(200);
    expect(body.toLowerCase()).not.toContain("<!doctype html>");
  });
});
