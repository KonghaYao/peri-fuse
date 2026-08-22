/**
 * Error investigation index for the lite web UI.
 *
 * Returns project-scoped error summaries, signatures and cursor-paginated
 * lightweight observations. Full IO stays behind the observation detail API.
 */

import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";

type ErrorCursor = { v: 1; startTime: string; id: string };

const ErrorQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().trim().max(500).optional(),
  type: z.string().trim().max(50).optional(),
  model: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function sqliteTime(value: string | undefined): string | undefined {
  return value ? new Date(value).toISOString().replace("T", " ").replace("Z", "") : undefined;
}

function isoTime(value: unknown): string | null {
  if (!value) return null;
  const text = String(value);
  return text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
}

function encodeCursor(row: Record<string, unknown>): string {
  const value: ErrorCursor = { v: 1, startTime: String(row.start_time), id: String(row.id) };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string | undefined): ErrorCursor | null | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ErrorCursor;
    return parsed.v === 1 && parsed.startTime && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

const app = new Hono<LiteServerEnv>();

app.get("/api/public/errors", authMiddleware, responseCache(3_000), async (c) => {
  const parsed = ErrorQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const cursor = decodeCursor(parsed.data.cursor);
  if (cursor === null) return c.json({ message: "Invalid cursor" }, 400);

  const projectId = c.get("auth").scope.projectId;
  const { search, type, model, limit } = parsed.data;
  const params: Record<string, unknown> = {
    projectId,
    rowLimit: limit + 1,
  };
  const where = ["o.project_id = @projectId", "o.is_deleted = 0", "o.level = 'ERROR'"];
  const from = sqliteTime(parsed.data.from);
  const to = sqliteTime(parsed.data.to);
  if (from) {
    where.push("o.start_time >= @from");
    params.from = from;
  }
  if (to) {
    where.push("o.start_time <= @to");
    params.to = to;
  }
  if (search) {
    where.push("(o.status_message LIKE @search OR o.name LIKE @search OR o.trace_id LIKE @search)");
    params.search = `%${search}%`;
  }
  if (type) {
    where.push("o.type = @type");
    params.type = type;
  }
  if (model) {
    if (model === "(unknown)") {
      where.push("(o.model IS NULL OR o.model = '')");
    } else {
      where.push("o.model = @model");
      params.model = model;
    }
  }
  const baseWhere = where.join(" AND ");
  const pageWhere = cursor
    ? `${baseWhere} AND (o.start_time < @cursorTime OR (o.start_time = @cursorTime AND o.id < @cursorId))`
    : baseWhere;
  if (cursor) {
    params.cursorTime = cursor.startTime;
    params.cursorId = cursor.id;
  }

  const db = getTelemetryDB();
  const [summaryRows, groupRows, modelRows, dailyRows, errorRows] = await Promise.all([
    db.query<Record<string, unknown>>({
      query: `SELECT COUNT(*) AS totalErrors, COUNT(DISTINCT o.trace_id) AS affectedTraces,
                     COUNT(DISTINCT COALESCE(NULLIF(TRIM(o.status_message), ''), NULLIF(TRIM(o.name), ''), '(no error message)')) AS uniqueSignatures,
                     MIN(o.start_time) AS firstSeen, MAX(o.start_time) AS lastSeen
              FROM observations o WHERE ${baseWhere}`,
      params,
    }),
    db.query<Record<string, unknown>>({
      query: `SELECT COALESCE(NULLIF(TRIM(substr(o.status_message, 1, 500)), ''), NULLIF(TRIM(o.name), ''), '(no error message)') AS signature,
                     COUNT(*) AS count, COUNT(DISTINCT o.trace_id) AS traceCount,
                     MAX(o.start_time) AS lastSeen
              FROM observations o WHERE ${baseWhere}
              GROUP BY signature ORDER BY count DESC, lastSeen DESC LIMIT 8`,
      params,
    }),
    db.query<Record<string, unknown>>({
      query: `SELECT COALESCE(NULLIF(o.model, ''), '(unknown)') AS model, COUNT(*) AS count
              FROM observations o WHERE ${baseWhere}
              GROUP BY model ORDER BY count DESC LIMIT 6`,
      params,
    }),
    db.query<Record<string, unknown>>({
      query: `SELECT substr(o.start_time, 1, 10) AS date, COUNT(*) AS count
              FROM observations o WHERE ${baseWhere}
              GROUP BY date ORDER BY date DESC LIMIT 30`,
      params,
    }),
    db.query<Record<string, unknown>>({
      query: `SELECT o.id, o.trace_id, o.parent_observation_id, o.name, o.type,
                     o.start_time, o.end_time, substr(o.status_message, 1, 1000) AS status_message,
                     o.model, o.environment,
                     (SELECT t.name FROM traces t WHERE t.id = o.trace_id AND t.project_id = o.project_id) AS trace_name,
                     (SELECT t.session_id FROM traces t WHERE t.id = o.trace_id AND t.project_id = o.project_id) AS session_id,
                     (SELECT t.user_id FROM traces t WHERE t.id = o.trace_id AND t.project_id = o.project_id) AS user_id
              FROM observations o WHERE ${pageWhere}
              ORDER BY o.start_time DESC, o.id DESC LIMIT @rowLimit`,
      params,
    }),
  ]);

  const hasMore = errorRows.length > limit;
  const pageRows = hasMore ? errorRows.slice(0, limit) : errorRows;
  const summary = summaryRows[0] ?? {};
  return c.json({
    summary: {
      totalErrors: Number(summary.totalErrors ?? 0),
      affectedTraces: Number(summary.affectedTraces ?? 0),
      uniqueSignatures: Number(summary.uniqueSignatures ?? 0),
      firstSeen: isoTime(summary.firstSeen),
      lastSeen: isoTime(summary.lastSeen),
    },
    groups: groupRows.map((row) => ({
      signature: row.signature,
      count: Number(row.count),
      traceCount: Number(row.traceCount),
      lastSeen: isoTime(row.lastSeen),
    })),
    models: modelRows.map((row) => ({ model: row.model, count: Number(row.count) })),
    daily: dailyRows.map((row) => ({ date: row.date, count: Number(row.count) })).reverse(),
    data: pageRows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      parentObservationId: row.parent_observation_id,
      name: row.name,
      type: row.type,
      startTime: isoTime(row.start_time),
      endTime: isoTime(row.end_time),
      statusMessage: row.status_message,
      model: row.model,
      environment: row.environment,
      traceName: row.trace_name,
      sessionId: row.session_id,
      userId: row.user_id,
    })),
    meta: {
      cursor: hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]!) : null,
    },
  });
});

export default app;
