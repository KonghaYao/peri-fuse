import { statSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";
import type { LiteServerEnv } from "./auth";

// These are page routes from web/src/App.tsx, not arbitrary path prefixes.
// Keep this boundary in sync when adding pages; protocol discovery and unknown
// resources must never become successful HTML responses.
const PAGE_ROUTES = [
  /^\/$/,
  /^\/(dashboard|errors|observations|users|scores|settings)\/?$/,
  /^\/(traces|sessions)(\/[^/]+)?\/?$/,
  /^\/gateway(\/(providers|models|usage|logs))?\/?$/,
];
const PROTOCOL_PATH = /^\/(api|v1|mcp|\.well-known)(\/|$)/;

function acceptsHtml(accept: string | undefined): boolean {
  return (accept ?? "").split(",").some((range) => {
    const [type, ...parameters] = range.trim().toLowerCase().split(";");
    if (type.trim() !== "text/html") return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.trim().slice(2));
    return Number.isFinite(value) && value > 0 && value <= 1;
  });
}

/** Serve known browser pages and real assets without masking missing endpoints. */
export function serveWeb(webDist: string): MiddlewareHandler<LiteServerEnv> {
  const index = serveStatic({ root: webDist, path: "index.html" });
  const asset = serveStatic({ root: webDist });
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.notFound();
    let pathname: string;
    try {
      pathname = decodeURI(c.req.path);
    } catch {
      return c.notFound();
    }
    if (/(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}|\\/.test(pathname)) {
      return c.notFound();
    }
    if (PROTOCOL_PATH.test(pathname)) return c.notFound();

    if (pathname === "/index.html" || PAGE_ROUTES.some((route) => route.test(pathname))) {
      // Both 200 and 404 depend on Accept; a cache must not reuse a browser's
      // HTML response for a subsequent JSON client on the same URL.
      c.header("Vary", "Accept", { append: true });
      if (!acceptsHtml(c.req.header("accept"))) return c.notFound();
      return index(c, next);
    }

    // Only file-shaped requests reach static serving. In particular, an
    // existing directory must not get serveStatic's implicit index.html.
    if (!/\/[^/]+\.[^/]+$/.test(pathname)) return c.notFound();
    if (/\.html?$/i.test(pathname)) {
      c.header("Vary", "Accept", { append: true });
      if (!acceptsHtml(c.req.header("accept"))) return c.notFound();
    }
    try {
      if (!statSync(join(webDist, pathname)).isFile()) return c.notFound();
    } catch {
      return c.notFound();
    }
    return asset(c, next);
  };
}
