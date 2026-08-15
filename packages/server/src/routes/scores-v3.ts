/**
 * GET /api/public/v3/scores
 *
 * Langfuse API v3 scores endpoint (the CLI-canonical `scores list` path).
 *
 * Semantics:
 * - Keyset cursor pagination (ORDER BY timestamp DESC, id DESC), cursor
 *   payload {v:1, lastTimestamp, lastId} base64url-encoded; limit+1 probe for
 *   hasMore; meta.cursor is null on the final page. limit > 100 → 400.
 * - 17 comma-separated filter params; cross-field 400 validation:
 *   value requires a single NUMERIC/BOOLEAN/CATEGORICAL dataType,
 *   valueMin/valueMax require NUMERIC, traceId/sessionId/experimentId and
 *   sessionId/observationId are mutually exclusive, observationId requires
 *   traceId.
 * - Field groups: details (comment/configId/metadata), subject
 *   (kind + id), annotation (authorUserId/queueId). Unknown groups → 400
 *   (via the shared zod schema).
 */
import {
  filterAndValidateV3GetScoreList,
  GetScoresQueryV3,
  type ScoreFieldGroupV3,
} from "@peri-fuse/shared";
import { EncodedScoresCursorV3, logger } from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import type { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { listScoresV3ForPublicApiLite, type ScoresV3ListParams } from "../shaping/scores-v3";

const app = new Hono<LiteServerEnv>();

const VALUE_COMPATIBLE_DATA_TYPES = ["NUMERIC", "BOOLEAN", "CATEGORICAL"] as const;

/**
 * v3 cross-field validation (beyond the zod query schema). Returns an error
 * message, or null when the query is valid.
 */
function validateV3CrossParams(query: z.infer<typeof GetScoresQueryV3>): string | null {
  const dataType = query.dataType; // canonical uppercase values
  const hasValue = query.value !== undefined;
  const hasMin = query.valueMin !== undefined;
  const hasMax = query.valueMax !== undefined;

  const singleNumeric = dataType?.length === 1 && dataType[0] === "NUMERIC";

  if ((hasMin || hasMax) && !singleNumeric) {
    return "valueMin and valueMax require dataType=NUMERIC as a single value.";
  }
  if (hasValue) {
    if (!dataType?.length || dataType.length !== 1) {
      return "value requires a single dataType from NUMERIC, BOOLEAN, or CATEGORICAL.";
    }
    const dt = dataType[0];
    if (!(VALUE_COMPATIBLE_DATA_TYPES as readonly string[]).includes(dt)) {
      return `value requires dataType to be NUMERIC, BOOLEAN, or CATEGORICAL (got ${dt}).`;
    }
    if (dt === "BOOLEAN" && !query.value!.every((v) => v === "true" || v === "false")) {
      return "BOOLEAN value filter values must be 'true' or 'false'.";
    }
    if (dt === "NUMERIC" && !query.value!.every((v) => Number.isFinite(Number(v)))) {
      return "NUMERIC value filter values must be finite numbers.";
    }
  }

  const hasTrace = Boolean(query.traceId?.length);
  const hasSession = Boolean(query.sessionId?.length);
  const hasObservation = Boolean(query.observationId?.length);
  const hasExperiment = Boolean(query.experimentId?.length);

  if (hasTrace && hasSession) return "traceId and sessionId are mutually exclusive.";
  if (hasTrace && hasExperiment) return "traceId and experimentId are mutually exclusive.";
  if (hasSession && hasObservation) return "sessionId and observationId are mutually exclusive.";
  if (hasSession && hasExperiment) return "sessionId and experimentId are mutually exclusive.";
  if (hasObservation && hasExperiment)
    return "observationId and experimentId are mutually exclusive.";
  if (hasObservation && !hasTrace) {
    return "observationId requires traceId to be specified.";
  }
  return null;
}

app.get("/api/public/v3/scores", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");

  // The shared GetScoresQueryV3 is .strict() and does not declare `cursor`
  // (it is validated separately below), so strip it before schema validation.
  const rawQuery = c.req.query();
  const { cursor: rawCursor, ...restQuery } = rawQuery;

  const parsed = GetScoresQueryV3.safeParse(restQuery);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;

  // userId / traceTags are declared in the query schema only so a stray empty
  // `?userId=` from a templating system parses (empty → undefined). A non-empty
  // value has no v3 semantics (v3 has no trace JOIN) — reject loudly instead of
  // silently returning unfiltered data (the official spec ignores unknown
  // params, but this implementation declares them, so be consistent with the
  // `.strict()` unknown-param 400).
  if (query.userId !== undefined) {
    return c.json(
      {
        message:
          "userId filter is not supported by the v3 scores API. Use the v2 scores API instead.",
      },
      400,
    );
  }
  if (query.traceTags !== undefined) {
    return c.json(
      {
        message:
          "traceTags filter is not supported by the v3 scores API. Use the v2 scores API instead.",
      },
      400,
    );
  }

  const crossError = validateV3CrossParams(query);
  if (crossError) {
    return c.json({ message: crossError }, 400);
  }

  // Cursor decode (base64url {v:1, lastTimestamp, lastId}) — malformed → 400.
  // NOTE: EncodedScoresCursorV3's transform throws InvalidRequestError for
  // undecodable input instead of reporting a zod issue (zod 4 does not capture
  // throws inside .transform()), so wrap parse() in try/catch.
  let cursor: { lastTimestamp: Date; lastId: string } | undefined;
  if (rawCursor) {
    let parsedCursor: z.infer<typeof EncodedScoresCursorV3>;
    try {
      parsedCursor = EncodedScoresCursorV3.parse(rawCursor);
    } catch {
      return c.json({ message: "Invalid cursor format" }, 400);
    }
    cursor = parsedCursor;
  }

  const params: ScoresV3ListParams = {
    projectId: auth.scope.projectId,
    limit: query.limit,
    fields: (query.fields ?? ["core"]) as ScoreFieldGroupV3[],
    cursor,
    id: query.id,
    name: query.name,
    source: query.source,
    dataType: query.dataType,
    environment: query.environment,
    configId: query.configId,
    queueId: query.queueId,
    authorUserId: query.authorUserId,
    value: query.value,
    valueMin: query.valueMin,
    valueMax: query.valueMax,
    traceId: query.traceId,
    sessionId: query.sessionId,
    observationId: query.observationId,
    experimentId: query.experimentId,
    fromTimestamp: query.fromTimestamp,
    toTimestamp: query.toTimestamp,
  };

  const { data, cursor: nextCursor } = await listScoresV3ForPublicApiLite(params);

  return c.json({
    // A row failing the v3 schema validation is dropped (upstream behaviour);
    // log it so pagination gaps are diagnosable.
    data: filterAndValidateV3GetScoreList(data, (error) => {
      logger.warn(
        "[scores-v3] Dropped score row failing APIScoreSchemaV3 validation",
        error.issues,
      );
    }),
    meta: {
      limit: query.limit,
      cursor: nextCursor ?? null,
    },
  });
});

export default app;
