/**
 * Hono application assembly for the lite server.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createGatewayProxyRouter } from "@peri/gateway/proxy-router";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { logger } from "@peri-fuse/shared/src/server";
import { TelemetryQueryError } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { LiteServerEnv } from "./auth";
import { largeResponseLogger } from "./large-response-logger";
import { requestLimits } from "./request-limits";
import dashboardRoutes from "./routes/dashboard";
import datasetItemsRoutes from "./routes/dataset-items";
import datasetsRoutes from "./routes/datasets";
import datasetsV2Routes from "./routes/datasets-v2";
import errorsRoutes from "./routes/errors";
import evalTemplatesRoutes from "./routes/eval-templates";
import evalsRoutes from "./routes/evals";
import gatewayProxyRoutes from "./routes/gateway-proxy";
import healthRoutes from "./routes/health";
import ingestionRoutes from "./routes/ingestion";
import manageRoutes from "./routes/manage";
import { createMcpRoutes } from "./routes/mcp";
import metricsV2Routes from "./routes/metrics-v2";
import observationsRoutes from "./routes/observations";
import observationsV2Routes from "./routes/observations-v2";
import otelRoutes from "./routes/otel";
import promptsV2Routes from "./routes/prompts-v2";
import scoreConfigsRoutes from "./routes/score-configs";
import scoresRoutes from "./routes/scores";
import scoresV2Routes from "./routes/scores-v2";
import scoresV3Routes from "./routes/scores-v3";
import sessionSearchRoutes from "./routes/session-search";
import sessionsRoutes from "./routes/sessions";
import tracesRoutes from "./routes/traces";
import usersRoutes from "./routes/users";
import { serveWeb } from "./spa";

export type LiteApp = Hono<LiteServerEnv> & { close: () => Promise<void> };

export function createApp(options: { webDist?: string } = {}): LiteApp {
  const app = new Hono<LiteServerEnv>();

  const limits = requestLimits();
  app.use("/api/*", limits);
  app.use("/v1/*", limits);
  app.use("/api/*", largeResponseLogger());

  // Mirror web's permissive CORS (origin: true, credentials: false) so SDKs
  // and browser-based clients can call the public API cross-origin.
  const corsConfig = cors({
    origin: (origin) => origin || "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-langfuse-sdk-name",
      "x-langfuse-sdk-version",
      "x-langfuse-sdk-integration",
      "x-langfuse-ingestion-version",
      "x-langfuse-public-key",
      "x-langfuse-secret-key",
      "x-langfuse-session-id",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
      "MCP-Session-Id",
      "Last-Event-ID",
      "Accept",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["MCP-Session-Id", "MCP-Protocol-Version"],
    credentials: false,
  });
  app.use("/api/public/*", corsConfig);
  app.use("/v1/*", corsConfig);
  app.use("/api/mcp/*", corsConfig);

  // Global error handler: map BaseError subclasses (incl. 404) to their
  // HTTP codes; everything else becomes a 500.
  app.onError((err, c) => {
    if (err instanceof TelemetryQueryError) {
      const status = err.code === "RESULT_LIMIT" ? 413 : 503;
      if (status === 503) c.header("Retry-After", "1");
      return c.json({ message: err.message }, status);
    }
    if (c.req.raw.signal.aborted) return c.json({ message: "Request cancelled" }, 408);
    if (err instanceof LangfuseNotFoundError) {
      return c.json({ message: err.message }, 404);
    }
    if (err instanceof BaseError) {
      if (!err.isUserError()) {
        logger.error(err);
      }
      return c.json({ error: err.name, message: err.message }, err.httpCode as 500);
    }
    logger.error("Unhandled lite-server error", err);
    return c.json({ message: "Internal Server Error" }, 500);
  });

  app.route("/", healthRoutes);
  app.route("/", manageRoutes);
  const mcpSkillsCandidates = [
    path.resolve(__dirname, "skills"),
    path.resolve(__dirname, "../../langfuse-mcp/skills"),
  ];
  const mcpSkillsDir = mcpSkillsCandidates.find((directory) =>
    fs.existsSync(path.join(directory, "langfuse", "SKILL.md")),
  );
  const mcp = createMcpRoutes(mcpSkillsDir ? { skillsDir: mcpSkillsDir } : {});
  app.route("/", mcp.routes);
  app.route("/", ingestionRoutes);
  app.route("/", otelRoutes);
  app.route("/", tracesRoutes);
  app.route("/", observationsRoutes);
  app.route("/", scoresRoutes);
  app.route("/", scoreConfigsRoutes);
  app.route("/", evalTemplatesRoutes);
  app.route("/", evalsRoutes);
  app.route("/", errorsRoutes);
  app.route("/", datasetsRoutes);
  app.route("/", datasetItemsRoutes);
  app.route("/", datasetsV2Routes);
  app.route("/", observationsV2Routes);
  app.route("/", promptsV2Routes);
  app.route("/", scoresV2Routes);
  app.route("/", scoresV3Routes);
  app.route("/", metricsV2Routes);
  app.route("/", sessionsRoutes);
  app.route("/", sessionSearchRoutes);
  app.route("/", usersRoutes);
  app.route("/", dashboardRoutes);
  app.route("/", gatewayProxyRoutes);

  // Gateway proxy routes (data plane): /v1/chat/completions, /v1/messages, /v1/models
  // Auth is handled internally by unifiedAuth middleware.
  app.route("/", createGatewayProxyRouter() as unknown as Hono<LiteServerEnv>);

  // --- API 404 兜底（必须在 SPA fallback 之前注册）---
  // 未注册的 /api/public/* 路径（任意方法）→ 404 JSON，复用 LangfuseNotFoundError
  // 经 onError 产出的 {message} 形状。此前这类路径会落入 SPA fallback 返回
  // 200 + index.html，导致 SDK/CLI 把 HTML 当 JSON 解析（静默失败）。
  app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/api/public/*", () => {
    throw new LangfuseNotFoundError();
  });
  // 其余以 /api/ 开头的未匹配路径：跳过 SPA fallback，走全局 JSON 404。
  app.use("/api/*", async (c) => {
    return c.notFound();
  });
  // Retired MCP path must not fall through to the SPA.
  app.use("/mcp/*", async (c) => c.notFound());

  // Serve the web SPA build when present. In development the frontend runs
  // on its own Vite dev server, so the dist folder may not exist — in that
  // case we skip static serving entirely.
  // Bundled CLI context: __dirname/web/ (copied at build time).
  // Monorepo context: __dirname/../../web/dist (packages/web/dist).
  const webDistCandidates = [
    path.resolve(__dirname, "web"),
    path.resolve(__dirname, "../../web/dist"),
  ];
  const webDist =
    options.webDist ?? webDistCandidates.find((d) => fs.existsSync(path.join(d, "index.html")));
  if (webDist) {
    app.use("/*", serveWeb(webDist));
    logger.info(`[lite-server] Serving lite-web SPA from ${webDist}`);
  } else {
    logger.info(
      "[lite-server] lite-web dist not found — API only (run the Vite dev server for the UI)",
    );
  }

  // Global JSON 404 for everything else (unknown routes, non-API paths when no
  // SPA build exists, etc.) — Hono's default fallback is text/plain.
  app.notFound((c) => c.json({ message: "Not Found" }, 404));

  return Object.assign(app, { close: mcp.close });
}
