/**
 * Gateway admin router — exported for direct mounting in the server.
 * No adminAuth middleware here; the caller decides how to protect it.
 */
import { Hono } from "hono";
import adminProviders from "./routes/admin/providers.js";
import adminCredentials from "./routes/admin/credentials.js";
import adminKeys from "./routes/admin/keys.js";
import adminModels from "./routes/admin/models.js";
import adminBudgets from "./routes/admin/budgets.js";
import adminUsage from "./routes/admin/usage.js";
import adminLogs from "./routes/admin/logs.js";
import adminAudit from "./routes/admin/audit.js";

export function createGatewayAdminRouter(): Hono {
  const router = new Hono();

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
