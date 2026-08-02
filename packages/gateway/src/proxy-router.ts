/**
 * Gateway proxy router — exported for direct mounting in the main server.
 * Includes unifiedAuth middleware so the caller does not need to apply auth.
 */
import { Hono } from "hono";
import type { GatewayEnv } from "./app.js";
import { unifiedAuth } from "./middleware/auth.js";
import chatRoutes from "./routes/proxy/chat.js";
import messagesRoutes from "./routes/proxy/messages.js";
import modelsRoutes from "./routes/proxy/models.js";

export function createGatewayProxyRouter(): Hono<GatewayEnv> {
  const router = new Hono<GatewayEnv>();

  router.use("/v1/*", unifiedAuth);
  router.route("/", chatRoutes); // POST /v1/chat/completions
  router.route("/", messagesRoutes); // POST /v1/messages
  router.route("/", modelsRoutes); // GET /v1/models

  return router;
}
