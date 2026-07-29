/**
 * GET /api/public/scores
 *
 * Simplified port of the GET path in web/src/pages/api/public/scores/index.ts
 * (v1 semantics, no rate limiting / audit log / deprecation headers).
 */

import { filterAndValidateLegacyV1GetScoreList, GetScoresQueryV1 } from "@peri-fuse/shared";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { generateScoresForPublicApi, getScoresCountForPublicApi } from "../shaping/scores";

const app = new Hono<LiteServerEnv>();

app.get("/api/public/scores", authMiddleware, async (c) => {
  const auth = c.get("auth");

  const rawQuery = c.req.query();
  const parsed = GetScoresQueryV1.safeParse(rawQuery);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;

  const scoreParams = {
    projectId: auth.scope.projectId,
    page: query.page ?? undefined,
    limit: query.limit ?? undefined,
    // The v1 query schema strips unknown keys, so `traceId` /
    // `observationId` are read from the raw query string. They are part of
    // ScoreQueryType and supported by the filter builder.
    traceId: rawQuery.traceId ?? undefined,
    observationId: rawQuery.observationId ? [rawQuery.observationId] : undefined,
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
    fields: query.fields ?? undefined,
    advancedFilters: query.filter,
  };

  const [items, count] = await Promise.all([
    generateScoresForPublicApi(scoreParams),
    getScoresCountForPublicApi(scoreParams),
  ]);

  const finalCount = count ? count : 0;

  return c.json({
    // As these are trace scores, we expect all scores to have a traceId set.
    // Validate against the v1 schema which requires a traceId.
    data: filterAndValidateLegacyV1GetScoreList(items),
    meta: {
      page: query.page,
      limit: query.limit,
      totalItems: finalCount,
      totalPages: Math.ceil(finalCount / query.limit),
    },
  });
});

export default app;
