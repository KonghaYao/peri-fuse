/**
 * Gateway admin router — exported for direct mounting in the main server.
 * Includes unifiedAuth middleware so the resolved projectId is available to
 * the project-scoped admin handlers (the caller does not need to apply auth).
 */
import { Hono } from "hono";
import type { GatewayEnv } from "./app.js";
import { unifiedAuth } from "./middleware/auth.js";
import adminAudit from "./routes/admin/audit.js";
import adminBudgets from "./routes/admin/budgets.js";
import adminCredentials from "./routes/admin/credentials.js";
import adminKeys from "./routes/admin/keys.js";
import adminLogs from "./routes/admin/logs.js";
import adminModels from "./routes/admin/models.js";
import adminProviders from "./routes/admin/providers.js";
import adminUsage from "./routes/admin/usage.js";

export function createGatewayAdminRouter(): Hono<GatewayEnv> {
  const router = new Hono<GatewayEnv>();

  router.use("/*", unifiedAuth);

  router.route("/providers", adminProviders);
  router.route("/credentials", adminCredentials);
  router.route("/keys", adminKeys);
  router.route("/models", adminModels);
  router.route("/budgets", adminBudgets);
  router.route("/usage", adminUsage);
  router.route("/logs", adminLogs);
  router.route("/audit", adminAudit);

  return router;
}
