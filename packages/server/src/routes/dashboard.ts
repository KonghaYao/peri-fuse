/**
 * GET /api/public/dashboard
 *
 * Lite-mode-only aggregate endpoint backing the lite-web dashboard. Figures
 * are served from the materialized per-day rollups (stats/daily-stats) with
 * live edge-day fallbacks, so a 30d window reads ~30 rollup rows instead of
 * scanning the whole observations table (see routes/dashboard-compute.ts).
 *
 * Accepts optional `from` / `to` ISO-instant query params to bound the window;
 * when omitted, stats cover all time.
 *
 * Cache TTL is window-aware: windows reaching back further than 24h are
 * dominated by immutable history, so they may live in cache much longer than
 * near-realtime windows.
 */

import { logger } from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { buildDashboard, emptyDashboardBody } from "./dashboard-compute";

const app = new Hono<LiteServerEnv>();

const SHORT_WINDOW_TTL_MS = 5_000;
const HISTORICAL_WINDOW_TTL_MS = 60_000;
const HISTORICAL_WINDOW_AGE_MS = 24 * 3600_000;

/**
 * Normalize an ISO-8601 instant to the SQLite TEXT timestamp format used by the
 * telemetry store ("YYYY-MM-DD HH:MM:SS.sss"), so range params compare correctly.
 */
function toSqliteTime(value: string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function windowTtlMs(fromIso: string | undefined): number {
  if (!fromIso) return SHORT_WINDOW_TTL_MS;
  const fromMs = new Date(fromIso).getTime();
  if (Number.isNaN(fromMs)) return SHORT_WINDOW_TTL_MS;
  return Date.now() - fromMs > HISTORICAL_WINDOW_AGE_MS
    ? HISTORICAL_WINDOW_TTL_MS
    : SHORT_WINDOW_TTL_MS;
}

app.get(
  "/api/public/dashboard",
  authMiddleware,
  responseCache((c) => windowTtlMs(c.req.query("from"))),
  async (c) => {
    const auth = c.get("auth");
    const projectId = auth.scope.projectId;

    // Optional time range (ISO instants). When omitted, stats cover all time.
    const from = toSqliteTime(c.req.query("from") ?? "");
    const to = toSqliteTime(c.req.query("to") ?? "");

    try {
      const body = await buildDashboard(projectId, { from, to });
      return c.json(body);
    } catch (error) {
      logger.error("[lite-server] dashboard query failed", error);
      return c.json(emptyDashboardBody(), 200);
    }
  },
);

export default app;
