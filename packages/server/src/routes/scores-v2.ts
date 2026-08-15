/**
 * GET /api/public/v2/scores and GET /api/public/v2/scores/{scoreId}
 *
 * Langfuse API v2 scores endpoints (deprecated upstream in favor of v3, but
 * still served by the CLI for --api-version 3.x).
 *
 * v2 list semantics: page/limit pagination, the v1 filter set extended with
 * sessionId/datasetRunId/traceId/observationId, a `filter` JSON param, and a
 * `fields` group list ('score' / 'trace' — both default). The `trace` group
 * JOINs the traces table (userId/tags/environment/sessionId); filtering by
 * trace properties (userId/traceTags) requires the `trace` group (else 400).
 */
import { filterAndValidateV2GetScoreList, LangfuseNotFoundError } from "@peri-fuse/shared";
import type { ScoreQueryType } from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { GetScoreByIdQueryV2, GetScoresQueryV2 } from "../schemas/scores-v2";
import {
  generateScoresForPublicApiV2,
  getScoreByIdForPublicApiV2,
  getScoresCountForPublicApiV2,
} from "../shaping/scores-v2";

const app = new Hono<LiteServerEnv>();

/**
 * v2-specific cross-parameter validation (beyond the zod query schema):
 * filtering by trace properties requires the `trace` field group.
 * Returns an error message, or null when the query is valid.
 */
function validateV2FieldsConstraint(query: {
  userId?: string | null;
  traceTags?: string | string[] | null;
  fields?: string[] | null;
}): string | null {
  const hasTracePropertyFilter =
    (query.userId !== undefined && query.userId !== null) ||
    (query.traceTags !== undefined && query.traceTags !== null);
  if (hasTracePropertyFilter && !(query.fields ?? []).includes("trace")) {
    return "When filtering by trace properties (userId or traceTags), the 'trace' field group must be included.";
  }
  return null;
}

app.get("/api/public/v2/scores", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");

  const parsed = GetScoresQueryV2.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;

  const fieldsError = validateV2FieldsConstraint(query);
  if (fieldsError) {
    return c.json({ message: fieldsError }, 400);
  }

  const scoreParams: ScoreQueryType = {
    projectId: auth.scope.projectId,
    page: query.page,
    limit: query.limit,
    userId: query.userId ?? undefined,
    name: query.name ?? undefined,
    configId: query.configId ?? undefined,
    queueId: query.queueId ?? undefined,
    traceTags: query.traceTags ?? undefined,
    dataType: query.dataType ?? undefined,
    fromTimestamp: query.fromTimestamp ?? undefined,
    toTimestamp: query.toTimestamp ?? undefined,
    environment: query.environment ?? undefined,
    source: query.source ?? undefined,
    value: query.value ?? undefined,
    operator: query.operator ?? undefined,
    scoreIds: query.scoreIds ?? undefined,
    fields: query.fields,
    traceId: query.traceId ?? undefined,
    observationId: query.observationId ?? undefined,
    sessionId: query.sessionId ?? undefined,
    datasetRunId: query.datasetRunId ?? undefined,
    advancedFilters: query.filter,
  };

  const [items, count] = await Promise.all([
    generateScoresForPublicApiV2(scoreParams),
    getScoresCountForPublicApiV2(scoreParams),
  ]);

  return c.json({
    data: filterAndValidateV2GetScoreList(items),
    meta: {
      page: query.page,
      limit: query.limit,
      totalItems: count,
      totalPages: Math.ceil(count / query.limit),
    },
  });
});

app.get("/api/public/v2/scores/:scoreId", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");

  const parsed = GetScoreByIdQueryV2.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { scoreId } = parsed.data;

  const score = await getScoreByIdForPublicApiV2(auth.scope.projectId, scoreId);
  if (!score) {
    throw new LangfuseNotFoundError(`Score ${scoreId} not found in project`);
  }

  return c.json(score);
});

export default app;
