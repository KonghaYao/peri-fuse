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

import { LangfuseNotFoundError } from "@peri-fuse/shared";
import {
  convertObservation,
  liteGetObservationsForTraces,
  logger,
} from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { transformDbToApiObservation } from "../shaping/observations";
import { aggregateTraceMetrics, parseJsonValue, toMs } from "../shaping/trace-metrics";

const app = new Hono<LiteServerEnv>();

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
  environment: z.string().optional(),
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
// ---------------------------------------------------------------------------

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

app.get("/api/public/sessions", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const parsed = GetSessionsQuery.safeParse(c.req.query());
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

    const rows = await db.query<SessionListRow>({
      query: `
        WITH page_sessions AS (
          SELECT t.session_id AS id,
                 MIN(t.timestamp) AS created_at,
                 COUNT(*) AS count_traces,
                 (julianday(MAX(t.timestamp)) - julianday(MIN(t.timestamp))) * 86400.0
                   AS session_duration,
                 GROUP_CONCAT(t.tags, CHAR(31)) AS tags_concat,
                 MAX(t.environment) AS environment
          FROM traces t
          WHERE t.project_id = @projectId
            AND t.is_deleted = 0
            AND t.session_id IS NOT NULL
            AND t.session_id != ''
            ${filterSql}
          GROUP BY t.session_id
          ORDER BY ${orderExpr} ${orderDir}, t.session_id ASC
          LIMIT @limit OFFSET @offset
        )
        SELECT ps.*,
               m.input_cost, m.output_cost, m.total_cost,
               m.input_tokens, m.output_tokens, m.total_tokens,
               m.cached_tokens,
               u.users_concat
        FROM page_sessions ps
        LEFT JOIN (
          SELECT session_id,
                 SUM(input_cost) AS input_cost,
                 SUM(output_cost) AS output_cost,
                 SUM(total_cost) AS total_cost,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(cached_tokens), 0) AS cached_tokens
          FROM trace_metrics
          WHERE project_id = @projectId
            AND session_id IN (SELECT id FROM page_sessions)
          GROUP BY session_id
        ) m ON m.session_id = ps.id
        LEFT JOIN (
          SELECT session_id, GROUP_CONCAT(user_id, CHAR(31)) AS users_concat
          FROM (
            SELECT DISTINCT session_id, user_id
            FROM trace_metrics
            WHERE project_id = @projectId
              AND session_id IN (SELECT id FROM page_sessions)
              AND user_id IS NOT NULL AND user_id != ''
          )
          GROUP BY session_id
        ) u ON u.session_id = ps.id
      `,
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
    return c.json(
      {
        data: [],
        meta: { page, limit, totalItems: 0, totalPages: 0 },
      },
      200,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /api/public/sessions/:sessionId
//
// Session detail: header metrics plus the session's traces with per-trace
// metrics (reusing the traces-metrics aggregation) and trace scores.
// ---------------------------------------------------------------------------

type SessionScoreRow = {
  id: string;
  trace_id: string;
  observation_id: string | null;
  name: string;
  value: number | null;
  string_value: string | null;
  data_type: string;
  comment: string | null;
  source: string;
};

app.get("/api/public/sessions/:sessionId", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const sessionId = c.req.param("sessionId");

  const db = getTelemetryDB();

  const traceRows = await db.query<Record<string, unknown>>({
    query: `
      SELECT id, name, timestamp, user_id, input, output, environment
      FROM traces
      WHERE project_id = @projectId
        AND session_id = @sessionId
        AND is_deleted = 0
      ORDER BY timestamp ASC, id ASC
    `,
    params: { projectId, sessionId },
  });

  if (traceRows.length === 0) {
    throw new LangfuseNotFoundError(`Session ${sessionId} not found within authorized project`);
  }

  const traceIds = traceRows.map((t) => String(t.id));
  const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
  const obsParams: Record<string, unknown> = { projectId };
  traceIds.forEach((id, i) => {
    obsParams[`id${i}`] = id;
  });

  const [obsRows, scoreRows] = await Promise.all([
    db.query<Record<string, unknown>>({
      query: `
        SELECT trace_id, level, start_time, end_time, usage_details,
               cost_details, total_cost
        FROM observations
        WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
      `,
      params: obsParams,
    }),
    db.query<SessionScoreRow>({
      query: `
        SELECT id, trace_id, observation_id, name, value, string_value, data_type, comment, source
        FROM scores
        WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
        ORDER BY timestamp ASC
      `,
      params: obsParams,
    }),
  ]);

  const obsByTrace = new Map<string, Array<Record<string, unknown>>>();
  for (const row of obsRows) {
    const tid = String(row.trace_id);
    const list = obsByTrace.get(tid) ?? [];
    list.push(row);
    obsByTrace.set(tid, list);
  }

  const scoresByTrace = new Map<string, SessionScoreRow[]>();
  for (const row of scoreRows) {
    const list = scoresByTrace.get(row.trace_id) ?? [];
    list.push(row);
    scoresByTrace.set(row.trace_id, list);
  }

  // Full observation shapes per trace — batched into a single SQLite query
  // (avoids N+1) so the session view can render the merged observation tree
  // and open a per-observation detail panel. IO is included (matching the
  // trace detail endpoint) so the panel's Input/Output/Metadata tabs are
  // populated.
  type ApiObservation = ReturnType<typeof transformDbToApiObservation>;
  const observationsByTraceId = new Map<string, ApiObservation[]>();
  const batchedObs = await liteGetObservationsForTraces(projectId, traceIds, true);
  for (const [tid, records] of batchedObs) {
    observationsByTraceId.set(
      tid,
      records.map((r) =>
        transformDbToApiObservation({
          ...convertObservation({ ...r, metadata: r.metadata ?? {} }),
          inputPrice: null,
          outputPrice: null,
          totalPrice: null,
        }),
      ),
    );
  }

  const timestamps = traceRows
    .map((t) => toMs(t.timestamp))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  const sessionDuration =
    timestamps.length > 1 ? (timestamps[timestamps.length - 1]! - timestamps[0]!) / 1000 : 0;

  const users = Array.from(
    new Set(
      traceRows.map((t) => t.user_id).filter((u): u is string => u !== null && u !== undefined),
    ),
  );

  let totalCost = 0;
  const traces = traceRows.map((t) => {
    const metrics = aggregateTraceMetrics(String(t.id), obsByTrace.get(String(t.id)) ?? [], {
      input: parseJsonValue(t.input),
      output: parseJsonValue(t.output),
      metadata: null,
    });
    totalCost += metrics.calculatedTotalCost ?? 0;
    return {
      id: metrics.id,
      name: t.name,
      timestamp: toIso(t.timestamp),
      userId: t.user_id ?? null,
      input: metrics.input,
      output: metrics.output,
      latency: metrics.latency,
      totalCost: metrics.calculatedTotalCost,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      totalTokens: metrics.totalTokens,
      cachedTokens: metrics.cachedTokens,
      cacheHitRate: metrics.cacheHitRate,
      scores: (scoresByTrace.get(String(t.id)) ?? []).map((s) => ({
        id: s.id,
        observationId: s.observation_id,
        name: s.name,
        value: s.value,
        stringValue: s.string_value,
        dataType: s.data_type,
        comment: s.comment,
        source: s.source,
      })),
      observations: observationsByTraceId.get(String(t.id)) ?? [],
    };
  });

  return c.json({
    id: sessionId,
    createdAt: toIso(traceRows[0]?.timestamp),
    users,
    countTraces: traceRows.length,
    totalCost,
    sessionDuration,
    environment: traceRows[0]?.environment ?? "default",
    traces,
  });
});

export default app;
