/**
 * Frozen pre-P1 session list statement (baseline for `sessions-query-plan.test.ts`
 * and the scaling probe).
 *
 * This is a verbatim copy of the statement the route executed before the
 * performance review §3 change. It is a *reference implementation*: it is never
 * executed by the route, only by tests that compare results, plans and latency
 * against the current query.
 */

/** Sortable column -> SQL expression, mirroring the route's allowlist. */
export const ORDER_EXPRESSIONS: Record<string, string> = {
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

export type ResolvedOrder = { expr: string; dir: "ASC" | "DESC" };

/** Resolves the sort key the same way the route's allowlist does. */
export function resolveOrder(orderBy: string | null): ResolvedOrder {
  const [column, order] = (orderBy ?? "").split(".");
  const expr = ORDER_EXPRESSIONS[column ?? ""];
  if (!expr) return { expr: "created_at", dir: "DESC" };
  return { expr, dir: order?.toUpperCase() === "ASC" ? "ASC" : "DESC" };
}

/** Mirrors the route's trace-level filter fragments. */
export function legacyFilterFragment(query: URLSearchParams): string {
  const filters: string[] = [];
  if (query.get("sessionId")) filters.push("t.session_id = @sessionId");
  if (query.get("tags"))
    filters.push("EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = @tag)");
  if (query.get("userId")) filters.push("t.user_id LIKE @userId");
  if (query.get("environment")) filters.push("t.environment LIKE @environment");
  if (query.get("fromTimestamp")) filters.push("t.timestamp >= @fromTimestamp");
  if (query.get("toTimestamp")) filters.push("t.timestamp <= @toTimestamp");
  return filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
}

export function legacySessionListSql(query: URLSearchParams): string {
  const { expr, dir } = resolveOrder(query.get("orderBy"));
  const filterSql = legacyFilterFragment(query);
  return `
        WITH filtered_traces AS (
          SELECT t.id, t.project_id, t.session_id, t.user_id,
                 t.timestamp, t.tags, t.environment
          FROM traces t
          WHERE t.project_id = @projectId
            AND t.is_deleted = 0
            AND t.session_id IS NOT NULL
            AND t.session_id != ''
            ${filterSql}
        ), session_base AS (
          SELECT t.session_id AS id,
                 MIN(t.timestamp) AS created_at,
                 COUNT(*) AS count_traces,
                 (julianday(MAX(t.timestamp)) - julianday(MIN(t.timestamp))) * 86400.0
                   AS session_duration,
                 GROUP_CONCAT(t.tags, CHAR(31)) AS tags_concat,
                 MAX(t.environment) AS environment
          FROM filtered_traces t
          GROUP BY t.session_id
        ), session_metrics AS (
          SELECT ft.session_id,
                 SUM(input_cost) AS input_cost,
                 SUM(output_cost) AS output_cost,
                 SUM(total_cost) AS total_cost,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(cached_tokens), 0) AS cached_tokens
          FROM filtered_traces ft
          LEFT JOIN trace_metrics tm
            ON tm.project_id = ft.project_id AND tm.trace_id = ft.id
          GROUP BY ft.session_id
        ), session_users AS (
          SELECT session_id, GROUP_CONCAT(user_id, CHAR(31)) AS users_concat
          FROM (
            SELECT DISTINCT session_id, user_id
            FROM filtered_traces
            WHERE user_id IS NOT NULL AND user_id != ''
          )
          GROUP BY session_id
        ), sessions AS (
          SELECT sb.*, sm.input_cost, sm.output_cost, sm.total_cost,
                 sm.input_tokens, sm.output_tokens, sm.total_tokens,
                 sm.cached_tokens, su.users_concat
          FROM session_base sb
          LEFT JOIN session_metrics sm ON sm.session_id = sb.id
          LEFT JOIN session_users su ON su.session_id = sb.id
        )
        SELECT *
        FROM sessions
        ORDER BY ${expr} ${dir}, id ASC
        LIMIT @limit OFFSET @offset
      `;
}

export function legacySessionCountSql(query: URLSearchParams): string {
  return `
        SELECT COUNT(DISTINCT session_id) as count
        FROM traces t
        WHERE t.project_id = @projectId
          AND t.is_deleted = 0
          AND t.session_id IS NOT NULL
          AND t.session_id != ''
          ${legacyFilterFragment(query)}
      `;
}
