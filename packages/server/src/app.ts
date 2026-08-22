/**
 * Hono application assembly for the lite server.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createGatewayProxyRouter } from "@peri/gateway/proxy-router";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { logger } from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { LiteServerEnv } from "./auth";
import { largeResponseLogger } from "./large-response-logger";
import dashboardRoutes from "./routes/dashboard";
import datasetItemsRoutes from "./routes/dataset-items";
import datasetsRoutes from "./routes/datasets";
import datasetsV2Routes from "./routes/datasets-v2";
import evalTemplatesRoutes from "./routes/eval-templates";
import evalsRoutes from "./routes/evals";
import gatewayProxyRoutes from "./routes/gateway-proxy";
import healthRoutes from "./routes/health";
import ingestionRoutes from "./routes/ingestion";
import manageRoutes from "./routes/manage";
import metricsV2Routes from "./routes/metrics-v2";
import observationsRoutes from "./routes/observations";
import observationsV2Routes from "./routes/observations-v2";
import otelRoutes from "./routes/otel";
import promptsV2Routes from "./routes/prompts-v2";
import scoreConfigsRoutes from "./routes/score-configs";
import scoresRoutes from "./routes/scores";
import scoresV2Routes from "./routes/scores-v2";
import scoresV3Routes from "./routes/scores-v3";
import sessionsRoutes from "./routes/sessions";
import tracesRoutes from "./routes/traces";
import usersRoutes from "./routes/users";

export function createApp(): Hono<LiteServerEnv> {
  const app = new Hono<LiteServerEnv>();

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
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  });
  app.use("/api/public/*", corsConfig);
  app.use("/v1/*", corsConfig);

  // Global error handler: map BaseError subclasses (incl. 404) to their
  // HTTP codes; everything else becomes a 500.
  app.onError((err, c) => {
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
  app.route("/", ingestionRoutes);
  app.route("/", otelRoutes);
  app.route("/", tracesRoutes);
  app.route("/", observationsRoutes);
  app.route("/", scoresRoutes);
  app.route("/", scoreConfigsRoutes);
  app.route("/", evalTemplatesRoutes);
  app.route("/", evalsRoutes);
  app.route("/", datasetsRoutes);
  app.route("/", datasetItemsRoutes);
  app.route("/", datasetsV2Routes);
  app.route("/", observationsV2Routes);
  app.route("/", promptsV2Routes);
  app.route("/", scoresV2Routes);
  app.route("/", scoresV3Routes);
  app.route("/", metricsV2Routes);
  app.route("/", sessionsRoutes);
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

  // Serve the web SPA build when present. In development the frontend runs
  // on its own Vite dev server, so the dist folder may not exist — in that
  // case we skip static serving entirely.
  // Bundled CLI context: __dirname/web/ (copied at build time).
  // Monorepo context: __dirname/../../web/dist (packages/web/dist).
  const webDistCandidates = [
    path.resolve(__dirname, "web"),
    path.resolve(__dirname, "../../web/dist"),
  ];
  const webDist = webDistCandidates.find((d) => fs.existsSync(path.join(d, "index.html")));
  if (webDist) {
    // Static assets (JS/CSS/images). Also serves `/` via directory-index
    // resolution (webDist/index.html). Unmatched paths fall through (next()).
    app.use("/*", serveStatic({ root: webDist }));
    // SPA fallback: any non-API route that did not match a static file serves
    // index.html so client-side routing works on deep links / refresh.
    app.get("*", serveStatic({ root: webDist, path: "index.html" }));
    logger.info(`[lite-server] Serving lite-web SPA from ${webDist}`);
  } else {
    logger.info(
      "[lite-server] lite-web dist not found — API only (run the Vite dev server for the UI)",
    );
  }

  // Global JSON 404 for everything else (unknown routes, non-API paths when no
  // SPA build exists, etc.) — Hono's default fallback is text/plain.
  app.notFound((c) => c.json({ message: "Not Found" }, 404));

  return app;
}
