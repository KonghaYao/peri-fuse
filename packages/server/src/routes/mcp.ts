import { createLangfuseMcpHandler } from "@peri-fuse/langfuse-mcp";
import { Hono } from "hono";
import type { LiteServerEnv } from "../auth";
import { authMiddleware } from "../auth";

/** MCP Streamable HTTP endpoint, protected by the same project-scoped Basic auth as the API. */
export function createMcpRoutes(options: { skillsDir?: string } = {}) {
  const mcpHandler = createLangfuseMcpHandler(options);
  const routes = new Hono<LiteServerEnv>();
  routes.all("/api/mcp", authMiddleware, async (c) => mcpHandler.fetch(c.req.raw));
  return { routes, close: () => mcpHandler.close() };
}

export default createMcpRoutes;
