/**
 * GET /api/public/sessions and GET /api/public/sessions/:sessionId
 *
 * Lite-mode-only endpoints backing the lite-web sessions views. In lite mode
 * there is no dedicated sessions store — sessions are derived from
 * `traces.session_id` (the Postgres `traceSession` metadata such as
 * bookmark/public is not available in lite mode). Aggregates are computed
 * directly from the SQLite telemetry store (mirrors web's `getSessionsTable`
 * / `getSessionsWithMetrics` ClickHouse queries).
 */

import { logger } from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { toSqliteTime } from "../shaping/metrics-v2-filters";

import sessionDetailRoutes from "./session-detail";

const app = new Hono<LiteServerEnv>();
app.route("/", sessionDetailRoutes);

const SESSION_LIST_LIMIT_DEFAULT = 50;
const SESSION_LIST_LIMIT_MAX = 500;
// Unit separator — used as GROUP_CONCAT delimiter (via SQLite CHAR(31)) so
// values containing commas (user ids) do not collide.
const US = "\u001f";

const GetSessionsQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SESSION_LIST_LIMIT_MAX)
    .default(SESSION_LIST_LIMIT_DEFAULT),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.string().optional(),
  environment: z.string().optional(),
  fromTimestamp: z.string().datetime().optional(),
  toTimestamp: z.string().datetime().optional(),
  // orderBy=column.asc|desc; column validated against an allowlist below.
  orderBy: z.string().optional(),
});

// Allowlist of sortable columns -> SQL expression (aggregated alias in the
// `sessions` CTE). Prevents SQL injection through the orderBy parameter.
const ORDER_COLUMNS: Record<string, string> = {
  createdAt: "created_at",
  id: "id",
  countTraces: "count_traces",
  sessionDuration: "session_duration",
  inputCost: "input_cost",
  outputCost: "output_cost",
  totalCost: "total_cost",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  totalTokens: "total_tokens",
};

function parseOrderBy(orderBy: string | undefined): {
  expr: string;
  dir: "ASC" | "DESC";
} {
  const fallback = { expr: "created_at", dir: "DESC" as const };
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

function parseTagsConcat(concat: unknown): string[] {
  if (concat === null || concat === undefined) return [];
  const tags = new Set<string>();
  for (const raw of String(concat).split(US)) {
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const t of parsed) if (typeof t === "string") tags.add(t);
      }
    } catch {
      // ignore malformed tag blobs
    }
  }
  return Array.from(tags);
}

function parseUsersConcat(concat: unknown): string[] {
  if (concat === null || concat === undefined) return [];
  return String(concat).split(US).filter(Boolean);
}

// ---------------------------------------------------------------------------
// GET /api/public/sessions
//
// Paginated session list with per-session metrics. Sessions are groups of
// traces sharing a session_id; observation cost/token aggregates are joined
// per trace first (avoids row multiplication on the traces<->observations
// join), then summed per session.
//
// Query shape (performance review §3): the page is chosen BEFORE the
// per-session metrics/users aggregation, so a 50-row page only pays for the
// sessions it returns. Two shapes are needed because the sort key decides what
// must be aggregated over every matching trace first:
//
// - trace-ranked keys (created_at / count_traces / session_duration / id): one
//   pass over the filtered traces ranks the sessions, then the page is re-read
//   through the (project_id, is_deleted, session_id) index;
// - metric-ranked keys (cost / token sums): the sums must exist for every
//   matching session before the page can be chosen, so the metrics aggregate
//   stays global while everything else stays page-scoped.
//
// The aggregate CTEs are explicitly MATERIALIZED: an unmaterialized GROUP BY
// subquery joined on session_id is re-evaluated once per outer row by the
// planner (O(sessions x traces), measured at ~30x on 1k traces), and the
// ranking CTEs are read twice by design. Materializing keeps every pass bounded
// to one scan of the rows it aggregates.
// ---------------------------------------------------------------------------

/** `t`-aliased trace filter shared by every aggregate below. */
function traceWhereSql(filterSql: string): string {
  return `t.project_id = @projectId
            AND t.is_deleted = 0
            AND t.session_id IS NOT NULL
            AND t.session_id != ''
            ${filterSql}`;
}

const TRACE_COLUMNS = `t.id, t.project_id, t.session_id, t.user_id,
                 t.timestamp, t.tags, t.environment`;

/** Ranking columns: what ORDER BY can sort sessions by without metrics. */
const RANKING_AGGREGATES = `MIN(t.timestamp) AS created_at,
                 COUNT(*) AS count_traces,
                 (julianday(MAX(t.timestamp)) - julianday(MIN(t.timestamp))) * 86400.0
                   AS session_duration`;

/** Page columns: ranking columns plus the page-only display fields. */
const PAGE_AGGREGATES = `${RANKING_AGGREGATES},
                 GROUP_CONCAT(t.tags, CHAR(31)) AS tags_concat,
                 MAX(t.environment) AS environment`;

const METRIC_AGGREGATES = `SUM(tm.input_cost) AS input_cost,
                 SUM(tm.output_cost) AS output_cost,
                 SUM(tm.total_cost) AS total_cost,
                 COALESCE(SUM(tm.input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(tm.output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(tm.total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(tm.cached_tokens), 0) AS cached_tokens`;

/** Sort keys that require the metrics aggregate before pagination. */
const METRIC_ORDER_KEYS = new Set([
  "input_cost",
  "output_cost",
  "total_cost",
  "input_tokens",
  "output_tokens",
  "total_tokens",
]);

/**
 * Builds the list statement. `orderExpr` is an allowlisted SQL expression (see
 * ORDER_COLUMNS) and `filterSql` only contains generated trace-level filters.
 */
function buildSessionListSql(options: {
  filterSql: string;
  orderExpr: string;
  orderDir: "ASC" | "DESC";
}): string {
  const { filterSql, orderExpr, orderDir } = options;
  const where = traceWhereSql(filterSql);
  const metricsRanked = METRIC_ORDER_KEYS.has(orderExpr);
  const rankCtes = metricsRanked
    ? `session_metrics AS MATERIALIZED (
          SELECT t.session_id AS id, ${METRIC_AGGREGATES}
          FROM traces t
          LEFT JOIN trace_metrics tm
            ON tm.project_id = t.project_id AND tm.trace_id = t.id
          WHERE ${where}
          GROUP BY t.session_id
        ), page_metrics AS MATERIALIZED (
          SELECT * FROM session_metrics
          ORDER BY ${orderExpr} ${orderDir}, id ASC
          LIMIT @limit OFFSET @offset
        )`
    : `session_base AS MATERIALIZED (
          SELECT t.session_id AS id, ${RANKING_AGGREGATES}
          FROM traces t
          WHERE ${where}
          GROUP BY t.session_id
        ), page_sessions AS MATERIALIZED (
          SELECT id FROM session_base
          ORDER BY ${orderExpr} ${orderDir}, id ASC
          LIMIT @limit OFFSET @offset
        )`;
  // The page CTE drives the page-scoped re-read; the metrics CTE holds the page
  // rows (metric-ranked) or is computed for the page rows only.
  const pageSource = metricsRanked ? "page_metrics" : "page_sessions";
  const metricsSource = metricsRanked ? "page_metrics" : "session_metrics";
  const finalOrder = metricsRanked ? `sm.${orderExpr}` : `pb.${orderExpr}`;
  // Metric-ranked pages already carry the aggregate; otherwise it is computed
  // for the page's traces only.
  const pageMetricsCte = metricsRanked
    ? ""
    : `, session_metrics AS MATERIALIZED (
          SELECT ft.session_id AS id, ${METRIC_AGGREGATES}
          FROM page_traces ft
          LEFT JOIN trace_metrics tm
            ON tm.project_id = ft.project_id AND tm.trace_id = ft.id
          GROUP BY ft.session_id
        )`;

  return `
        WITH ${rankCtes}, page_traces AS MATERIALIZED (
          -- CROSS JOIN fixes the join order (SQLite hint): drive the page ids
          -- and look every session's traces up through idx_traces_deleted_session
          -- instead of scanning the whole traces table for a 50-row page.
          SELECT ${TRACE_COLUMNS}
          FROM ${pageSource} ps
          CROSS JOIN traces t ON t.session_id = ps.id
          WHERE ${where}
        ), page_base AS MATERIALIZED (
          SELECT t.session_id AS id, ${PAGE_AGGREGATES}
          FROM page_traces t
          GROUP BY t.session_id
        )${pageMetricsCte}, session_users AS MATERIALIZED (
          SELECT session_id AS id, GROUP_CONCAT(user_id, CHAR(31)) AS users_concat
          FROM (
            SELECT DISTINCT session_id, user_id
            FROM page_traces
            WHERE user_id IS NOT NULL AND user_id != ''
          )
          GROUP BY session_id
        )
        SELECT pb.id, pb.created_at, pb.count_traces, pb.session_duration,
               pb.tags_concat, pb.environment,
               sm.input_cost, sm.output_cost, sm.total_cost,
               sm.input_tokens, sm.output_tokens, sm.total_tokens,
               sm.cached_tokens, su.users_concat
        FROM ${pageSource} ps
        JOIN page_base pb ON pb.id = ps.id
        LEFT JOIN ${metricsSource} sm ON sm.id = ps.id
        LEFT JOIN session_users su ON su.id = ps.id
        ORDER BY ${finalOrder} ${orderDir}, pb.id ASC
      `;
}

type SessionListRow = {
  id: string;
  created_at: string;
  count_traces: number;
  session_duration: number | null;
  users_concat: string | null;
  tags_concat: string | null;
  environment: string;
  input_cost: number | null;
  output_cost: number | null;
  total_cost: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
};

app.get("/api/public/sessions", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const parsed = GetSessionsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { page, limit, userId, sessionId, tags, environment, fromTimestamp, toTimestamp } =
    parsed.data;
  const { expr: orderExpr, dir: orderDir } = parseOrderBy(parsed.data.orderBy);

  const db = getTelemetryDB();
  try {
    const filters: string[] = [];
    const params: Record<string, unknown> = { projectId };
    if (sessionId) {
      filters.push("t.session_id = @sessionId");
      params.sessionId = sessionId;
    }
    if (tags) {
      filters.push("EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = @tag)");
      params.tag = tags;
    }
    if (userId) {
      // Substring match — the UI commits free text from a search box.
      filters.push("t.user_id LIKE @userId");
      params.userId = `%${userId}%`;
    }
    if (environment) {
      filters.push("t.environment LIKE @environment");
      params.environment = `%${environment}%`;
    }
    if (fromTimestamp) {
      filters.push("t.timestamp >= @fromTimestamp");
      params.fromTimestamp = toSqliteTime(fromTimestamp);
    }
    if (toTimestamp) {
      filters.push("t.timestamp <= @toTimestamp");
      params.toTimestamp = toSqliteTime(toTimestamp);
    }
    const filterSql = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

    const rows = await db.query<SessionListRow>({
      query: buildSessionListSql({ filterSql, orderExpr, orderDir }),
      params: { ...params, limit, offset: (page - 1) * limit },
    });

    const countRows = await db.query<{ count: number }>({
      query: `
        SELECT COUNT(DISTINCT session_id) as count
        FROM traces t
        WHERE t.project_id = @projectId
          AND t.is_deleted = 0
          AND t.session_id IS NOT NULL
          AND t.session_id != ''
          ${filterSql}
      `,
      params,
    });

    const totalItems = Number(countRows[0]?.count ?? 0);

    return c.json({
      data: rows.map((row) => ({
        id: row.id,
        createdAt: toIso(row.created_at),
        countTraces: Number(row.count_traces),
        sessionDuration: row.session_duration === null ? null : Number(row.session_duration),
        userIds: parseUsersConcat(row.users_concat),
        traceTags: parseTagsConcat(row.tags_concat),
        environment: row.environment,
        inputCost: row.input_cost === null ? null : Number(row.input_cost),
        outputCost: row.output_cost === null ? null : Number(row.output_cost),
        totalCost: row.total_cost === null ? null : Number(row.total_cost),
        promptTokens: Number(row.input_tokens),
        completionTokens: Number(row.output_tokens),
        totalTokens: Number(row.total_tokens),
        cachedTokens: Number(row.cached_tokens),
      })),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    });
  } catch (error) {
    logger.error("[lite-server] sessions list query failed", error);
    throw error;
  }
});

export default app;
