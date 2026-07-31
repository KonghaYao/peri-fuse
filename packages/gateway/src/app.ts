/**
 * Hono application assembly for PeriGateway.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/proxy/chat.js";
import messagesRoutes from "./routes/proxy/messages.js";
import modelsRoutes from "./routes/proxy/models.js";
import adminProviders from "./routes/admin/providers.js";
import adminCredentials from "./routes/admin/credentials.js";
import adminKeys from "./routes/admin/keys.js";
import adminModels from "./routes/admin/models.js";
import adminBudgets from "./routes/admin/budgets.js";
import adminUsage from "./routes/admin/usage.js";
import adminLogs from "./routes/admin/logs.js";
import adminAudit from "./routes/admin/audit.js";
import { proxyAuth, adminAuth } from "./middleware/auth.js";
import { hookRegistry } from "./hooks/registry.js";
import { parallelLimiterHook } from "./hooks/parallel-limiter.js";
import { rateLimiterHook } from "./hooks/rate-limiter.js";
import { budgetLimiterHook } from "./hooks/budget-limiter.js";
import { periFuseLoggerHook } from "./hooks/peri-fuse-logger.js";

export type GatewayEnv = {
  Variables: {
    apiKeyId: string;
    apiKeyPrefix: string;
    apiKeyRecord: {
      id: string;
      publicKey: string;
      spend: number;
      models: string;
      maxParallel: number | null;
      tpmLimit: number | null;
      rpmLimit: number | null;
      maxBudget: number | null;
      budgetId: string | null;
      metadata: string;
      isEnabled: boolean;
    };
  };
};

// Register built-in hooks (execution order matters)
hookRegistry.register(parallelLimiterHook);
hookRegistry.register(rateLimiterHook);
hookRegistry.register(budgetLimiterHook);
hookRegistry.register(periFuseLoggerHook);

export function createApp(): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();

  // CORS for admin ui
  app.use(
    "/admin/*",
    cors({
      origin: (origin) => origin || "*",
      allowHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-api-key"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: false,
    }),
  );

  // Global error handler
  app.onError((err, c) => {
    const status = "statusCode" in err ? (err as any).statusCode : 500;
    const message = err.message || "Internal Server Error";

    if (status >= 500) {
      console.error("[peri-gateway] Unhandled error:", err);
    }

    return c.json(
      {
        error: {
          message,
          type: err.name || "GatewayError",
          code: status,
        },
      },
      status as 500,
    );
  });

  // Health check (no auth)
  app.route("/", healthRoutes);

  // Proxy routes (data plane) — require API key auth
  app.use("/v1/*", proxyAuth);
  app.route("/", chatRoutes);
  app.route("/", messagesRoutes);
  app.route("/", modelsRoutes);

  // Admin routes (control plane) — require admin key
  app.use("/admin/*", adminAuth);
  app.route("/admin/providers", adminProviders);
  app.route("/admin/credentials", adminCredentials);
  app.route("/admin/keys", adminKeys);
  app.route("/admin/models", adminModels);
  app.route("/admin/budgets", adminBudgets);
  app.route("/admin/usage", adminUsage);
  app.route("/admin/logs", adminLogs);
  app.route("/admin/audit", adminAudit);

  return app;
}
