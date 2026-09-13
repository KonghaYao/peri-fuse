/** Session detail keeps the SDK default and offers bounded trace pages for the dashboard. */
import { LangfuseNotFoundError } from "@peri-fuse/shared";
import { convertObservation, liteGetObservationsForTraces } from "@peri-fuse/shared/src/server";
import { getTelemetryDB, TelemetryQueryError } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { transformDbToApiObservation } from "../shaping/observations";
import { getSessionTraceMetrics } from "../shaping/session-detail-metrics";
import { parseJsonValue, toMs } from "../shaping/trace-metrics";

const app = new Hono<LiteServerEnv>();
const booleanQuery = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value !== "false");
const GetSessionDetailQuery = z.object({
  includeObservations: booleanQuery,
  includeIo: booleanQuery,
  page: z.coerce
    .number()
    .int()
    .positive()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 500))
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
function toIso(value: unknown): string {
  return `${String(value).replace(" ", "T")}Z`;
}

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

app.get("/api/public/sessions/:sessionId", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const sessionId = c.req.param("sessionId");
  const parsed = GetSessionDetailQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { includeObservations, includeIo } = parsed.data;
  const paged = parsed.data.page !== undefined || parsed.data.limit !== undefined;
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 50;

  const db = getTelemetryDB();

  const [summary] = await db.query<{
    count: number;
    first: string;
    last: string;
    total_cost: number;
    total_tokens: number;
  }>({
    query: `WITH costs AS (
        SELECT o.trace_id,
          SUM(COALESCE(o.total_cost, json_extract(o.cost_details, '$.total'), 0)) AS total,
          SUM(COALESCE(json_extract(o.cost_details, '$.input'), 0) +
            COALESCE(json_extract(o.cost_details, '$.output'), 0)) AS fallback
        FROM observations o JOIN traces t ON t.id = o.trace_id AND t.project_id = o.project_id
        WHERE t.project_id = @projectId AND t.session_id = @sessionId
          AND t.is_deleted = 0 AND o.is_deleted = 0 GROUP BY o.trace_id
      ) SELECT COUNT(*) AS count, MIN(t.timestamp) AS first, MAX(t.timestamp) AS last,
      COALESCE(SUM(CASE WHEN costs.total > 0 THEN costs.total
        WHEN costs.fallback > 0 THEN costs.fallback ELSE 0 END), 0) AS total_cost,
      COALESCE(SUM(tm.total_tokens), 0) AS total_tokens
      FROM traces t LEFT JOIN trace_metrics tm ON tm.project_id = t.project_id AND tm.trace_id = t.id
      LEFT JOIN costs ON costs.trace_id = t.id
      WHERE t.project_id = @projectId AND t.session_id = @sessionId AND t.is_deleted = 0`,
    params: { projectId, sessionId },
  });
  if (!summary?.count) {
    throw new LangfuseNotFoundError(`Session ${sessionId} not found within authorized project`);
  }
  if (!paged && summary.count > 10_000) {
    throw new TelemetryQueryError(
      "RESULT_LIMIT",
      "Session exceeds 10000 traces; request page and limit",
    );
  }

  const traceRows = await db.query<Record<string, unknown>>({
    query: `
      SELECT id, name, timestamp, user_id, environment
             ${includeIo ? ", input, output" : ""}
      FROM traces
      WHERE project_id = @projectId
        AND session_id = @sessionId
        AND is_deleted = 0
      ORDER BY timestamp ASC, id ASC
      ${paged ? "LIMIT @limit OFFSET @offset" : ""}
    `,
    params: { projectId, sessionId, ...(paged ? { limit, offset: (page - 1) * limit } : {}) },
  });

  const traceIds = traceRows.map((t) => String(t.id));
  const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
  const obsParams: Record<string, unknown> = { projectId };
  traceIds.forEach((id, i) => {
    obsParams[`id${i}`] = id;
  });

  const [metricsByTrace, scoreRows] = await Promise.all([
    getSessionTraceMetrics(projectId, traceIds),
    traceIds.length === 0
      ? Promise.resolve([] as SessionScoreRow[])
      : db.query<SessionScoreRow>({
          query: `SELECT id, trace_id, observation_id, name, value, string_value, data_type, comment, source
          FROM scores WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
          ORDER BY timestamp ASC`,
          params: obsParams,
        }),
  ]);

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
  const batchedObs =
    includeObservations && traceIds.length > 0
      ? await liteGetObservationsForTraces(projectId, traceIds, includeIo)
      : new Map();
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

  const sessionDuration = ((toMs(summary.last) ?? 0) - (toMs(summary.first) ?? 0)) / 1000;
  const [userRows, firstTrace] = await Promise.all([
    db.query<{ user_id: string }>({
      query: `SELECT DISTINCT user_id FROM traces WHERE project_id = @projectId
        AND session_id = @sessionId AND is_deleted = 0 AND user_id IS NOT NULL
        ORDER BY user_id ${paged ? "LIMIT 101" : ""}`,
      params: { projectId, sessionId },
    }),
    db.query<{ environment: string }>({
      query: `SELECT environment FROM traces WHERE project_id = @projectId
        AND session_id = @sessionId AND is_deleted = 0 ORDER BY timestamp ASC, id ASC LIMIT 1`,
      params: { projectId, sessionId },
    }),
  ]);
  const users = (paged ? userRows.slice(0, 100) : userRows).map((row) => row.user_id);

  let totalCost = 0;
  const traces = traceRows.map((t) => {
    const metrics = metricsByTrace.get(String(t.id));
    totalCost += metrics?.totalCost ?? 0;
    return {
      id: String(t.id),
      name: t.name,
      timestamp: toIso(t.timestamp),
      userId: t.user_id ?? null,
      input: includeIo ? parseJsonValue(t.input) : null,
      output: includeIo ? parseJsonValue(t.output) : null,
      latency: metrics?.latency ?? null,
      totalCost: metrics?.totalCost ?? null,
      promptTokens: metrics?.promptTokens ?? 0,
      completionTokens: metrics?.completionTokens ?? 0,
      totalTokens: metrics?.totalTokens ?? 0,
      cachedTokens: metrics?.cachedTokens ?? 0,
      cacheHitRate: metrics?.cacheHitRate ?? 0,
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
      observations: includeObservations ? (observationsByTraceId.get(String(t.id)) ?? []) : [],
    };
  });

  return c.json({
    id: sessionId,
    createdAt: toIso(summary.first),
    users,
    countTraces: summary.count,
    totalCost: paged ? summary.total_cost : totalCost,
    totalTokens: summary.total_tokens,
    sessionDuration,
    environment: firstTrace[0]?.environment ?? "default",
    traces,
    ...(paged
      ? {
          usersTruncated: userRows.length > 100,
          meta: {
            page,
            limit,
            totalItems: summary.count,
            totalPages: Math.ceil(summary.count / limit),
          },
        }
      : {}),
  });
});

export default app;
