import { serve } from "@hono/node-server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLangfuseMcpHandler, serverFactory } from "./server.js";

/** Optional local entry point; the main server embeds the Fetch handler directly. */
function main(): void {
  if (process.argv.includes("--stdio")) {
    const handle = serveStdio(serverFactory, { legacy: "reject" });
    process.once("SIGTERM", () => void handle.close());
    process.once("SIGINT", () => void handle.close());
    return;
  }
  const hostname = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8457);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const handler = createLangfuseMcpHandler();
  const server = serve({ fetch: (request) => handler.fetch(request), hostname, port }, () => {
    console.error(`langfuse-mcp listening: http://${hostname}:${port}/mcp`);
  });
  const shutdown = () => {
    server.close();
    void handler.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

try {
  main();
} catch (error) {
  console.error("Failed to start Langfuse MCP", error);
  process.exitCode = 1;
}
