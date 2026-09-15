/**
 * Langfuse MCPP server — 将包内 `skills/langfuse/` 投影为 MCP Resources（MCPP 通道 B）。
 * 协议：MCP 2026-07-28（通过 Fetch handler 承载，兼容 legacy stateless 请求）。
 */
import { resolve } from "node:path";
import {
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { createMcppServerFactory } from "@peri-code/mcpp/server";
import { ResourceForSkills } from "@peri-code/mcpp/skills";

/** MCPP 约定：skillsDir 为各 skill 子目录的父路径；`skills/langfuse` 即 skill 名 `langfuse` */
const SKILLS_DIR = resolve(__dirname, "../skills");
const ORIGIN = "langfuse-mcp";

export interface LangfuseMcpOptions {
  /** Explicit skills directory; useful for bundled distributions. */
  skillsDir?: string;
  mcpp?: {
    capabilities?: Record<string, unknown>;
    resourceCache?: object;
  };
}

export function createLangfuseMcpServer(options: LangfuseMcpOptions = {}): McpServer {
  const { skillsDir = SKILLS_DIR, mcpp } = options;
  const server = new McpServer(
    { name: "langfuse-mcp", version: "0.1.0" },
    {
      capabilities: mcpp?.capabilities,
      instructions:
        "Exposes the langfuse skill (CLI, scripts, references) as MCP resources. " +
        "Read skill://langfuse/SKILL.md first, then skill://langfuse/<path> as needed.",
    },
  );

  ResourceForSkills(server, {
    skillsDir,
    origin: ORIGIN,
    ...(mcpp?.resourceCache ?? {}),
  });

  return server;
}

export const serverFactory: McpServerFactory = createMcppServerFactory(
  { cacheVersion: "langfuse-mcp-0.1.0" },
  (_request, mcpp) => createLangfuseMcpServer({ mcpp }),
);

/** Create a request handler suitable for Hono, Node HTTP, or another Fetch host. */
export function createLangfuseMcpHandler(options: { skillsDir?: string } = {}): McpHttpHandler {
  return createMcpHandler(
    createMcppServerFactory({ cacheVersion: "langfuse-mcp-0.1.0" }, (_request, mcpp) =>
      createLangfuseMcpServer({ skillsDir: options.skillsDir, mcpp }),
    ),
    { legacy: "stateless" },
  );
}
