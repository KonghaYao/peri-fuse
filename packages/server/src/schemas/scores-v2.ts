/**
 * Query schemas for the v2 scores endpoints (GET /api/public/v2/scores and
 * GET /api/public/v2/scores/{scoreId}).
 *
 * The v2 list endpoint is the superset of the v1 GET /scores query: it adds
 * sessionId / datasetRunId / traceId / observationId filters and — unlike v1 —
 * requires an explicit, strictly-validated `fields` group list (unknown groups
 * → 400, and trace-property filters (userId/traceTags) require the `trace`
 * group → 400).
 */
import {
  optionalJsonParam,
  publicApiPaginationZod,
  ScoreDataTypeDomain,
  ScoreSourceDomain,
  singleFilter,
  stringDateTime,
} from "@peri-fuse/shared";
import { z } from "zod";

/** Field groups accepted by v2/scores. */
export const SCORE_FIELD_GROUPS_V2 = ["score", "trace"] as const;
export type ScoreFieldGroupV2 = (typeof SCORE_FIELD_GROUPS_V2)[number];

/**
 * Comma-separated field groups. Defaults to ["score", "trace"] (spec: "If not
 * specified, both 'score' and 'trace' are returned by default"). Unknown group
 * names fail the z.enum() parse → HTTP 400.
 */
const fieldsParam = z
  .string()
  .nullish()
  .transform((value) => {
    if (!value) return ["score", "trace"] as ScoreFieldGroupV2[];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  })
  .pipe(z.array(z.enum(SCORE_FIELD_GROUPS_V2)));

/** Comma-separated string list (scoreIds / observationId). */
const commaSeparatedIds = z
  .string()
  .transform((str) =>
    str
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .nullish();

// GET /api/public/v2/scores
export const GetScoresQueryV2 = z.object({
  ...publicApiPaginationZod,
  userId: z.string().nullish(),
  name: z.string().nullish(),
  fromTimestamp: stringDateTime,
  toTimestamp: stringDateTime,
  environment: z.union([z.array(z.string()), z.string()]).nullish(),
  source: ScoreSourceDomain.nullish(),
  operator: z.enum(["<", ">", "<=", ">=", "!=", "="]).nullish(),
  value: z.coerce.number().nullish(),
  scoreIds: commaSeparatedIds,
  configId: z.string().nullish(),
  sessionId: z.string().nullish(),
  datasetRunId: z.string().nullish(),
  traceId: z.string().nullish(),
  observationId: commaSeparatedIds,
  queueId: z.string().nullish(),
  dataType: ScoreDataTypeDomain.nullish(),
  traceTags: z.union([z.array(z.string()), z.string()]).nullish(),
  fields: fieldsParam,
  filter: optionalJsonParam(z.array(singleFilter), "filter"),
});

// GET /api/public/v2/scores/{scoreId}
export const GetScoreByIdQueryV2 = z.object({
  scoreId: z.string(),
});
