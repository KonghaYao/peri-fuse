/**
 * GET /api/public/users
 *
 * Lite-mode-only endpoint backing the lite-web users view. There is no
 * dedicated users store in lite mode — users are derived from
 * `traces.user_id`. Per-user metrics (trace/observation counts, token and
 * cost aggregates, first/last seen) are computed directly from the SQLite
 * telemetry store, mirroring the sessions aggregation pattern: observation
 * cost/token totals are joined per trace first (avoids row multiplication on
 * the traces<->observations join), then summed per user.
 */

import { logger } from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";

const app = new Hono<LiteServerEnv>();

const USER_LIST_LIMIT_DEFAULT = 50;
const USER_LIST_LIMIT_MAX = 500;

const GetUsersQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(USER_LIST_LIMIT_MAX)
    .default(USER_LIST_LIMIT_DEFAULT),
  userId: z.string().optional(),
  environment: z.string().optional(),
  // orderBy=column.asc|desc; column validated against an allowlist below.
  orderBy: z.string().optional(),
});

// Allowlist of sortable columns -> SQL expression (aggregated alias in the
// `users` CTE). Prevents SQL injection through the orderBy parameter.
const ORDER_COLUMNS: Record<string, string> = {
  id: "id",
  firstSeen: "first_seen",
  lastSeen: "last_seen",
  countTraces: "count_traces",
  countObservations: "count_observations",
  totalCost: "total_cost",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  totalTokens: "total_tokens",
};

function parseOrderBy(orderBy: string | undefined): {
  expr: string;
  dir: "ASC" | "DESC";
} {
  const fallback = { expr: "last_seen", dir: "DESC" as const };
  if (!orderBy) return fallback;
  const [column, order] = orderBy.split(".");
  const expr = ORDER_COLUMNS[column ?? ""];
  if (!expr) return fallback;
  const dir = order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  return { expr, dir };
}

/** SQLite TEXT timestamp -> ISO-8601 UTC string (matches public API dates). */
function toIso(value: unknown): string {
  return `${String(value).replace(" ", "T")}Z`;
}

type UserListRow = {
  id: string;
  first_seen: string;
  last_seen: string;
  count_traces: number;
  count_observations: number;
  environment: string;
  input_cost: number | null;
  output_cost: number | null;
  total_cost: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

app.get("/api/public/users", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const parsed = GetUsersQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { page, limit, userId, environment } = parsed.data;
  const { expr: orderExpr, dir: orderDir } = parseOrderBy(parsed.data.orderBy);

  const db = getTelemetryDB();
  try {
    const filters: string[] = [];
    const params: Record<string, unknown> = { projectId };
    if (userId) {
      // Substring match — the UI commits free text from a search box.
      filters.push("t.user_id LIKE @userId");
      params.userId = `%${userId}%`;
    }
    if (environment) {
      filters.push("t.environment LIKE @environment");
      params.environment = `%${environment}%`;
    }
    const filterSql = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

    const rows = await db.query<UserListRow>({
      query: `
        WITH obs_per_trace AS (
          SELECT trace_id,
                 COUNT(*) AS obs_count,
                 SUM(total_cost) AS cost,
                 SUM(COALESCE(json_extract(cost_details, '$.input'), 0)) AS input_cost,
                 SUM(COALESCE(json_extract(cost_details, '$.output'), 0)) AS output_cost,
                 SUM(COALESCE(json_extract(usage_details, '$.input'), 0)) AS input_tokens,
                 SUM(COALESCE(json_extract(usage_details, '$.output'), 0)) AS output_tokens,
                 SUM(COALESCE(json_extract(usage_details, '$.total'),
                     COALESCE(json_extract(usage_details, '$.input'), 0) +
                     COALESCE(json_extract(usage_details, '$.output'), 0))) AS total_tokens
          FROM observations
          WHERE project_id = @projectId AND is_deleted = 0
          GROUP BY trace_id
        ),
        users AS (
          SELECT t.user_id AS id,
                 MIN(t.timestamp) AS first_seen,
                 MAX(t.timestamp) AS last_seen,
                 COUNT(*) AS count_traces,
                 COALESCE(SUM(o.obs_count), 0) AS count_observations,
                 MAX(t.environment) AS environment,
                 SUM(o.input_cost) AS input_cost,
                 SUM(o.output_cost) AS output_cost,
                 SUM(o.cost) AS total_cost,
                 COALESCE(SUM(o.input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(o.output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(o.total_tokens), 0) AS total_tokens
          FROM traces t
          LEFT JOIN obs_per_trace o ON o.trace_id = t.id
          WHERE t.project_id = @projectId
            AND t.is_deleted = 0
            AND t.user_id IS NOT NULL
            AND t.user_id != ''
            ${filterSql}
          GROUP BY t.user_id
        )
        SELECT * FROM users
        ORDER BY ${orderExpr} ${orderDir}, id ASC
        LIMIT @limit OFFSET @offset
      `,
      params: { ...params, limit, offset: (page - 1) * limit },
    });

    const countRows = await db.query<{ count: number }>({
      query: `
        SELECT COUNT(DISTINCT user_id) as count
        FROM traces t
        WHERE t.project_id = @projectId
          AND t.is_deleted = 0
          AND t.user_id IS NOT NULL
          AND t.user_id != ''
          ${filterSql}
      `,
      params,
    });

    const totalItems = Number(countRows[0]?.count ?? 0);

    return c.json({
      data: rows.map((row) => ({
        id: row.id,
        firstSeen: toIso(row.first_seen),
        lastSeen: toIso(row.last_seen),
        countTraces: Number(row.count_traces),
        countObservations: Number(row.count_observations),
        environment: row.environment,
        inputCost: row.input_cost === null ? null : Number(row.input_cost),
        outputCost: row.output_cost === null ? null : Number(row.output_cost),
        totalCost: row.total_cost === null ? null : Number(row.total_cost),
        promptTokens: Number(row.input_tokens),
        completionTokens: Number(row.output_tokens),
        totalTokens: Number(row.total_tokens),
      })),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    });
  } catch (error) {
    logger.error("[lite-server] users list query failed", error);
    return c.json(
      {
        data: [],
        meta: { page, limit, totalItems: 0, totalPages: 0 },
      },
      200,
    );
  }
});

export default app;
