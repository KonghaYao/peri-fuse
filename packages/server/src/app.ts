/**
 * Hono application assembly for the lite server.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { logger } from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { LiteServerEnv } from "./auth";
import dashboardRoutes from "./routes/dashboard";
import gatewayProxyRoutes from "./routes/gateway-proxy";
import healthRoutes from "./routes/health";
import ingestionRoutes from "./routes/ingestion";
import manageRoutes from "./routes/manage";
import observationsRoutes from "./routes/observations";
import otelRoutes from "./routes/otel";
import scoresRoutes from "./routes/scores";
import sessionsRoutes from "./routes/sessions";
import tracesRoutes from "./routes/traces";
import usersRoutes from "./routes/users";

export function createApp(): Hono<LiteServerEnv> {
  const app = new Hono<LiteServerEnv>();

  // Mirror web's permissive CORS (origin: true, credentials: false) so SDKs
  // and browser-based clients can call the public API cross-origin.
  app.use(
    "/api/public/*",
    cors({
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
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: false,
    }),
  );

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
  app.route("/", sessionsRoutes);
  app.route("/", usersRoutes);
  app.route("/", dashboardRoutes);
  app.route("/", gatewayProxyRoutes);

  // Serve the web SPA build when present. In development the frontend runs
  // on its own Vite dev server, so the dist folder may not exist — in that
  // case we skip static serving entirely.
  // Bundled CLI context: __dirname/web/ (copied at build time).
  // Monorepo context: __dirname/../../web/dist (packages/web/dist).
  const webDistCandidates = [
    path.resolve(__dirname, "web"),
    path.resolve(__dirname, "../../web/dist"),
  ];
  const webDist = webDistCandidates.find((d) =>
    fs.existsSync(path.join(d, "index.html")),
  );
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

  return app;
}
