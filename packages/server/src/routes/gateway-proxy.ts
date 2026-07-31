/**
 * Gateway admin proxy — forwards /api/gateway/* to the PeriGateway admin API.
 *
 * The web UI calls these endpoints same-origin; the server injects the
 * GATEWAY_ADMIN_KEY so the browser never sees it. No additional auth is
 * required on these routes (same trust model as /api/manage/*).
 */
import { Hono } from "hono";
import { liteEnv } from "../env";

const gatewayProxy = new Hono();

gatewayProxy.all("/api/gateway/*", async (c) => {
  // Strip /api/gateway prefix → /admin/*
  const subPath = c.req.path.replace(/^\/api\/gateway/, "/admin");
  const url = `${liteEnv.gatewayUrl}${subPath}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`;

  const headers: Record<string, string> = {
    "x-admin-key": liteEnv.gatewayAdminKey,
  };

  const contentType = c.req.header("content-type");
  if (contentType) headers["content-type"] = contentType;

  const init: RequestInit = {
    method: c.req.method,
    headers,
  };

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = await c.req.text();
  }

  try {
    const res = await fetch(url, init);
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return c.json(
      { error: { message: "Cannot reach gateway. Is it running?", type: "proxy_error" } },
      502,
    );
  }
});

export default gatewayProxy;
