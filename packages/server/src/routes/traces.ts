/**
 * GET /api/public/traces and GET /api/public/traces/:traceId
 *
 * Simplified ports of web/src/pages/api/public/traces/index.ts and
 * web/src/pages/api/public/traces/[traceId].ts (GET paths only, legacy
 * traces-table code path — the events-table path is not used in lite mode).
 */

import { filterAndValidateDbLegacyTraceScoreList, LangfuseNotFoundError } from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { models as modelsTable } from "@peri-fuse/shared/src/db/schema/index.js";
import {
  getObservationsForTrace,
  getScoresForTraces,
  getTraceById,
  logger,
  TRACE_FIELD_GROUPS,
  traceException,
} from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import Decimal from "decimal.js";
import { and, inArray, or, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { GetTracesV1Query, GetTraceV1Query } from "../schemas/traces";
import { transformDbToApiObservation } from "../shaping/observations";
import { aggregateTraceMetrics, parseJsonValue } from "../shaping/trace-metrics";
import { generateTracesForPublicApi, getTracesCountForPublicApi } from "../shaping/traces";

const app = new Hono<LiteServerEnv>();

app.get("/api/public/traces", authMiddleware, async (c) => {
  const auth = c.get("auth");

  const parsed = GetTracesV1Query.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;

  const filterProps = {
    projectId: auth.scope.projectId,
    page: query.page ?? undefined,
    limit: query.limit ?? undefined,
    fields: query.fields ?? undefined,
    userId: query.userId ?? undefined,
    name: query.name ?? undefined,
    tags: query.tags ?? undefined,
    environment: query.environment ?? undefined,
    sessionId: query.sessionId ?? undefined,
    version: query.version ?? undefined,
    release: query.release ?? undefined,
    fromTimestamp: query.fromTimestamp ?? undefined,
    toTimestamp: query.toTimestamp ?? undefined,
  };

  const [items, count] = await Promise.all([
    generateTracesForPublicApi({
      props: filterProps,
      advancedFilters: query.filter,
      orderBy: query.orderBy ?? null,
    }),
    getTracesCountForPublicApi({
      props: filterProps,
      advancedFilters: query.filter,
    }),
  ]);

  const finalCount = count || 0;
  return c.json({
    data: items.map((item) => ({
      ...item,
      externalId: null,
    })),
    meta: {
      page: query.page,
      limit: query.limit,
      totalItems: finalCount,
      totalPages: Math.ceil(finalCount / query.limit),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/public/traces/metrics?traceIds=a,b,c
//
// Lite-mode-only aggregate endpoint backing the lite-web traces table. For the
// given trace ids it returns per-trace metrics (latency, tokens, cost, level
// counts, observation count) plus input/output/metadata, computed directly from
// the SQLite telemetry store (mirrors web's `traces.metrics` tRPC + IO cells).
// Registered before the `:traceId` route so "metrics" is not matched as an id.
// ---------------------------------------------------------------------------

app.get("/api/public/traces/metrics", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const traceIds = (c.req.query("traceIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (traceIds.length === 0) return c.json([]);

  const db = getTelemetryDB();
  try {
    const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
    const params: Record<string, unknown> = { projectId };
    traceIds.forEach((id, i) => {
      params[`id${i}`] = id;
    });

    const [traceRows, obsRows] = await Promise.all([
      db.query<Record<string, unknown>>({
        query: `
          SELECT id, input, output, metadata
          FROM traces
          WHERE project_id = @projectId AND id IN (${placeholders}) AND is_deleted = 0
        `,
        params,
      }),
      db.query<Record<string, unknown>>({
        query: `
          SELECT trace_id, level, start_time, end_time, usage_details,
                 cost_details, total_cost
          FROM observations
          WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
        `,
        params,
      }),
    ]);

    const ioByTrace = new Map<string, { input: unknown; output: unknown; metadata: unknown }>();
    for (const row of traceRows) {
      ioByTrace.set(String(row.id), {
        input: parseJsonValue(row.input),
        output: parseJsonValue(row.output),
        metadata: parseJsonValue(row.metadata),
      });
    }

    const obsByTrace = new Map<string, Array<Record<string, unknown>>>();
    for (const row of obsRows) {
      const tid = String(row.trace_id);
      const list = obsByTrace.get(tid) ?? [];
      list.push(row);
      obsByTrace.set(tid, list);
    }

    const metrics = traceIds.map((traceId) =>
      aggregateTraceMetrics(
        traceId,
        obsByTrace.get(traceId) ?? [],
        ioByTrace.get(traceId) ?? { input: null, output: null, metadata: null },
      ),
    );

    return c.json(metrics);
  } catch (error) {
    logger.error("[lite-server] traces/metrics query failed", error);
    return c.json([], 200);
  }
});

app.get("/api/public/traces/:traceId", authMiddleware, async (c) => {
  const auth = c.get("auth");

  const parsed = GetTraceV1Query.safeParse({
    traceId: c.req.param("traceId"),
    ...c.req.query(),
  });
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { traceId } = parsed.data;

  const requestedFields = parsed.data.fields ?? TRACE_FIELD_GROUPS;
  const includeIO = requestedFields.includes("io");
  const includeObservations = requestedFields.includes("observations");
  const includeScores = requestedFields.includes("scores");
  const includeMetrics = requestedFields.includes("metrics");

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy public API endpoint reads from the legacy traces table.
  const trace = await getTraceById({
    traceId,
    projectId: auth.scope.projectId,
    excludeInputOutput: !includeIO,
    excludeMetadata: !includeIO,
  });

  if (!trace) {
    throw new LangfuseNotFoundError(`Trace ${traceId} not found within authorized project`);
  }

  const [observations, scores] = await Promise.all([
    includeObservations || includeMetrics
      ? getObservationsForTrace({
          traceId,
          projectId: auth.scope.projectId,
          timestamp: trace.timestamp,
          includeIO: includeObservations,
        })
      : Promise.resolve([]),
    includeScores
      ? getScoresForTraces({
          projectId: auth.scope.projectId,
          traceIds: [traceId],
          timestamp: trace.timestamp,
        })
      : Promise.resolve([]),
  ]);

  const uniqueModels: string[] = Array.from(
    new Set(observations.map((r) => r.internalModelId).filter((r): r is string => Boolean(r))),
  );

  const models =
    uniqueModels.length > 0
      ? await prisma.query.models.findMany({
          where: and(
            inArray(modelsTable.id, uniqueModels),
            or(eq(modelsTable.projectId, auth.scope.projectId), isNull(modelsTable.projectId)),
          ),
          with: {
            prices: true,
          },
        })
      : [];

  const observationsView = observations.map((o) => {
    const model = models.find((m) => m.id === o.internalModelId);
    const inputPrice = new Decimal(model?.prices.find((p) => p.usageType === "input")?.price ?? 0);
    const outputPrice = new Decimal(model?.prices.find((p) => p.usageType === "output")?.price ?? 0);
    const totalPrice = new Decimal(model?.prices.find((p) => p.usageType === "total")?.price ?? 0);
    return {
      ...o,
      inputPrice,
      outputPrice,
      totalPrice,
    };
  });

  const outObservations = observationsView.map(transformDbToApiObservation);
  // As these are trace scores, we expect all scores to have a traceId set.
  const validatedScores = filterAndValidateDbLegacyTraceScoreList({
    scores,
    onParseError: traceException,
  });

  const obsStartTimes = observations
    .map((o) => o.startTime)
    .sort((a, b) => a.getTime() - b.getTime());
  const obsEndTimes = observations
    .map((o) => o.endTime)
    .filter((t) => t)
    .sort((a, b) => (a as Date).getTime() - (b as Date).getTime());

  const latencyMs =
    obsStartTimes.length > 0
      ? obsEndTimes.length > 0
        ? (obsEndTimes[obsEndTimes.length - 1] as Date).getTime() - obsStartTimes[0]?.getTime()
        : obsStartTimes.length > 1
          ? obsStartTimes[obsStartTimes.length - 1]?.getTime() - obsStartTimes[0]?.getTime()
          : undefined
      : undefined;

  return c.json({
    ...trace,
    input: includeIO ? parseJsonValue(trace.input) : null,
    output: includeIO ? parseJsonValue(trace.output) : null,
    externalId: null,
    metadata: includeIO ? trace.metadata : {},
    scores: includeScores ? validatedScores : [],
    latency: includeMetrics ? (latencyMs !== undefined ? latencyMs / 1000 : 0) : -1,
    observations: includeObservations ? outObservations : [],
    htmlPath: `/project/${auth.scope.projectId}/traces/${traceId}`,
    totalCost: includeMetrics
      ? outObservations
          .reduce((acc, obs) => acc.add(obs.calculatedTotalCost ?? new Decimal(0)), new Decimal(0))
          .toNumber()
      : -1,
  });
});

export default app;
