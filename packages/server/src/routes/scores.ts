/**
 * GET /api/public/scores and POST /api/public/scores
 *
 * Simplified port of the GET + POST paths in
 * web/src/pages/api/public/scores/index.ts (v1 semantics, no rate limiting /
 * audit log / deprecation headers).
 *
 * POST wiring (phase-1-api-compat.md §4.2 / T4): body is validated against the
 * shared PostScoresBody (dataType inference, TEXT 1..500, BOOLEAN 0/1,
 * ANNOTATION-requires-configId refines), then validateAndInflateScore checks
 * configId existence + score/config consistency (InvalidRequestError → 400,
 * LangfuseNotFoundError → 404 — the only 404 source here), and the inflated
 * score is persisted to the telemetry `scores` table through the ingestion
 * event path.
 */

import { randomUUID } from "node:crypto";
import {
  CORRECTION_NAME,
  filterAndValidateLegacyV1GetScoreList,
  GetScoresQueryV1,
  InvalidRequestError,
  LangfuseNotFoundError,
  PostScoresBodyV1,
  type ScoreConfig as ScoreConfigDbType,
  type ScoreConfigDomain,
  ScoreDataTypeEnum,
} from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { scoreConfigs } from "@peri-fuse/shared/src/db/schema/index.js";
import {
  createIngestionAttribution,
  eventTypes,
  type IngestionHeaderMap,
  logger,
  processEventBatch,
  validateAndInflateScore,
  validateConfigAgainstBody,
} from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { generateScoresForPublicApi, getScoresCountForPublicApi } from "../shaping/scores";

const app = new Hono<LiteServerEnv>();

/**
 * Inflated score fields consumed by the telemetry `scores` row writer.
 * Structurally compatible with both `validateAndInflateScore` (shared) and
 * the lite re-implementation below.
 */
type InflatedScoreForWrite = {
  id: string;
  traceId?: string | null;
  observationId?: string | null;
  sessionId?: string | null;
  name: string;
  value: number;
  stringValue: string | null;
  source: string;
  comment?: string | null;
  configId?: string | null;
  dataType: string;
  environment: string;
  metadata?: unknown;
};

type PostScoreBody = z.infer<typeof PostScoresBodyV1>;

/**
 * SQLite `score_configs.categories` is a JSON text blob; parse it into the
 * domain shape. CATEGORICAL/BOOLEAN rows with missing/malformed categories
 * are treated as invalid configs (LangfuseNotFoundError), mirroring the
 * shared `validateDbScoreConfigSafe` failure inside validateAndInflateScore.
 */
const dbScoreConfigRowToDomain = (row: ScoreConfigDbType): ScoreConfigDomain => {
  const base = {
    id: row.id,
    name: row.name,
    isArchived: row.isArchived,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    projectId: row.projectId,
  };

  if (row.dataType === "NUMERIC") {
    return {
      ...base,
      dataType: "NUMERIC",
      minValue: row.minValue ?? undefined,
      maxValue: row.maxValue ?? undefined,
      categories: undefined,
    };
  }

  let categories: Array<{ value: number; label: string }>;
  try {
    const parsed: unknown = row.categories ? JSON.parse(row.categories) : undefined;
    if (!Array.isArray(parsed)) throw new Error("invalid categories");
    categories = parsed as Array<{ value: number; label: string }>;
  } catch {
    throw new LangfuseNotFoundError(
      "The configId you provided does not match a valid config in this project",
    );
  }

  if (row.dataType === "BOOLEAN") {
    return { ...base, dataType: "BOOLEAN", minValue: undefined, maxValue: undefined, categories };
  }
  if (row.dataType === "TEXT") {
    return {
      ...base,
      dataType: "TEXT",
      minValue: undefined,
      maxValue: undefined,
      categories: undefined,
    };
  }
  return { ...base, dataType: "CATEGORICAL", minValue: undefined, maxValue: undefined, categories };
};

/**
 * Inline mirror of the shared `inflateScoreBody` (validateAndInflateScore.ts).
 * Kept local because the shared version is private; the two must stay in
 * sync for the config branch.
 */
const inflateScoreBodyLite = (params: {
  projectId: string;
  scoreId: string;
  body: PostScoreBody & { name: string };
  config?: ScoreConfigDomain;
}): InflatedScoreForWrite => {
  const { body, projectId, scoreId, config } = params;
  const relevantDataType = config?.dataType ?? body.dataType;
  const scoreProps = {
    ...body,
    longStringValue: "",
    source: body.source ?? "API",
    id: scoreId,
    projectId,
  };

  if (typeof body.value === "number") {
    if (relevantDataType === ScoreDataTypeEnum.BOOLEAN) {
      const result = {
        ...scoreProps,
        value: body.value,
        stringValue: body.value === 1 ? "True" : "False",
        dataType: ScoreDataTypeEnum.BOOLEAN,
      };
      return result;
    }
    const result = {
      ...scoreProps,
      value: body.value,
      stringValue: null,
      dataType: ScoreDataTypeEnum.NUMERIC,
    };
    return result;
  }

  if (relevantDataType === ScoreDataTypeEnum.CORRECTION) {
    if (body.sessionId) {
      throw new InvalidRequestError(
        "CORRECTION scores cannot be associated with sessions. Please associate with a trace or observation instead.",
      );
    }
    if (body.datasetRunId) {
      throw new InvalidRequestError(
        "CORRECTION scores cannot be associated with dataset runs. Please associate with a trace or observation instead.",
      );
    }
    const result = {
      ...scoreProps,
      value: 0,
      name: CORRECTION_NAME,
      longStringValue: body.value,
      stringValue: body.value,
      dataType: ScoreDataTypeEnum.CORRECTION,
    };
    return result;
  }

  if (relevantDataType === ScoreDataTypeEnum.TEXT) {
    const result = {
      ...scoreProps,
      value: 0,
      stringValue: body.value,
      dataType: ScoreDataTypeEnum.TEXT,
    };
    return result;
  }

  const result = {
    ...scoreProps,
    value: config ? (config.categories?.find((cat) => cat.label === body.value)?.value ?? 0) : 0,
    stringValue: body.value,
    dataType: ScoreDataTypeEnum.CATEGORICAL,
  };
  return result;
};

/**
 * Lite adaptation of the shared `validateAndInflateScore` for
 * POST /api/public/scores (phase-1-api-compat.md §4.2).
 *
 * The no-config path delegates to the shared implementation. The config path
 * is re-implemented here: the shared implementation validates the DB row with
 * `ScoreConfigSchema`, which expects `categories` to be an array — but SQLite
 * stores it as a JSON text blob, so every CATEGORICAL/BOOLEAN config fails
 * validation and surfaces as a false 404. Here the row is parsed into the
 * domain shape, then the shared `validateConfigAgainstBody` (exported) keeps
 * the 400 semantics (name/dataType/range/archived mismatches) and the
 * inflated body mirrors the shared private `inflateScoreBody`.
 *
 * Throws InvalidRequestError → 400 / LangfuseNotFoundError → 404 via app.ts
 * onError; the 404 (configId does not exist in this project) is sourced here.
 */
const validateAndInflateScoreLite = async (params: {
  projectId: string;
  scoreId: string;
  body: PostScoreBody;
}): Promise<InflatedScoreForWrite> => {
  const { projectId, scoreId, body } = params;

  if (!body.configId) {
    return validateAndInflateScore({ projectId, scoreId, body });
  }

  const configRow = await prisma
    .select()
    .from(scoreConfigs)
    .where(and(eq(scoreConfigs.projectId, projectId), eq(scoreConfigs.id, body.configId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!configRow) {
    throw new LangfuseNotFoundError(
      "The configId you provided does not match a valid config in this project",
    );
  }

  const config = dbScoreConfigRowToDomain(configRow);
  validateConfigAgainstBody({ body, config, context: "INGESTION" });

  // The config's name overrides the body's name (mirrors the shared flow).
  return inflateScoreBodyLite({
    projectId,
    scoreId,
    body: { ...body, name: config.name },
    config,
  });
};

app.get("/api/public/scores", authMiddleware, responseCache(2_000), async (c) => {
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

app.post("/api/public/scores", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ message: "Invalid request data", errors: ["Invalid JSON body"] }, 400);
  }

  const parsedBody = PostScoresBodyV1.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json({ message: "Invalid request data", error: parsedBody.error.issues }, 400);
  }
  const body = parsedBody.data;

  // Config existence + score/config consistency (name, dataType, value range).
  // Throws InvalidRequestError → 400 / LangfuseNotFoundError → 404 via app.ts onError.
  const scoreId = body.id ?? randomUUID();
  const inflated = await validateAndInflateScoreLite({ projectId, scoreId, body });

  const event = {
    id: scoreId,
    type: eventTypes.SCORE_CREATE,
    timestamp: new Date().toISOString(),
    body: inflated,
  };

  const headers: IngestionHeaderMap = Object.fromEntries(c.req.raw.headers.entries());
  const result = await processEventBatch([event], auth, {
    attribution: createIngestionAttribution({ headers, authCheck: auth }),
  });

  // processEventBatchLite re-validates the event with the ingestion ScoreBody
  // schema, whose CATEGORICAL/TEXT/CORRECTION branches require a string
  // `value`. Inflated bodies carry the mapped numeric `value` (plus
  // stringValue/longStringValue), so those data types fail that re-validation
  // and never reach the writer. Fall back to a direct telemetry insert with
  // the exact row eventToRow would have produced (same columns, same
  // INSERT OR REPLACE upsert-on-id semantics).
  if (result.errors.length > 0) {
    const db = getTelemetryDB();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    try {
      await db.insert({
        table: "scores",
        records: [
          {
            id: inflated.id,
            project_id: projectId,
            created_at: now,
            updated_at: now,
            event_ts: now,
            is_deleted: 0,
            trace_id: inflated.traceId ?? null,
            observation_id: inflated.observationId ?? null,
            session_id: inflated.sessionId ?? null,
            name: inflated.name ?? "unknown",
            value: inflated.value ?? null,
            string_value: inflated.stringValue ?? null,
            source: inflated.source ?? "API",
            comment: inflated.comment ?? null,
            author_user_id: null,
            config_id: inflated.configId ?? null,
            data_type: inflated.dataType ?? "NUMERIC",
            timestamp: now,
            environment: inflated.environment ?? "default",
            metadata:
              inflated.metadata !== undefined && inflated.metadata !== null
                ? JSON.stringify(inflated.metadata)
                : "{}",
          },
        ],
      });
    } catch (error) {
      // The direct fallback is the last write path for inflated scores; a
      // failure here must surface as a 500 (not silently drop the score).
      logger.error("[POST /api/public/scores] Direct telemetry insert failed", error);
      throw new Error(
        `Failed to persist score ${inflated.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Official contract: 200 + { id } (upsert on id; SDK scores.create relies on
  // the JSON body).
  return c.json({ id: scoreId }, 200);
});

/**
 * DELETE /api/public/scores/{scoreId} (v1, CLI canonical `scores delete`).
 *
 * Soft delete (is_deleted = 1), mirroring upstream's ClickHouse delete-row
 * semantics — all read paths filter is_deleted = 0, so the score disappears
 * from every list/get. Project isolation via project_id in the WHERE clause;
 * a missing or already-deleted score (or one owned by another project) is a
 * 404. Spec: 204 with no body.
 */
app.delete("/api/public/scores/:scoreId", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const scoreId = c.req.param("scoreId");

  const db = getTelemetryDB();
  const result = await db.command({
    query:
      "UPDATE scores SET is_deleted = 1, updated_at = @now WHERE project_id = @projectId AND id = @scoreId AND is_deleted = 0",
    params: {
      projectId,
      scoreId,
      now: new Date().toISOString().replace("T", " ").replace("Z", ""),
    },
  });

  if (result.changes === 0) {
    throw new LangfuseNotFoundError(`Score with id '${scoreId}' not found`);
  }

  return c.body(null, 204);
});

export default app;
