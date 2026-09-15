import { createLangfuseMcpHandler } from "@peri-fuse/langfuse-mcp";
import { Hono } from "hono";
import type { LiteServerEnv } from "../auth";

/** Public, read-only distribution of packaged skills; no project data or credentials. */
export function createMcpRoutes(options: { skillsDir?: string } = {}) {
  const mcpHandler = createLangfuseMcpHandler(options);
  const routes = new Hono<LiteServerEnv>();
  routes.all("/mcp", async (c) => mcpHandler.fetch(c.req.raw));
  return { routes, close: () => mcpHandler.close() };
}

export default createMcpRoutes;
