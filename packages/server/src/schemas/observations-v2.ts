/**
 * Query schema for GET /api/public/v2/observations.
 *
 * Parameter set, field groups and pagination semantics follow the v4.10.0
 * openapi spec (`/api/public/v2/observations` + `ObservationV2` /
 * `ObservationsV2Response` / `ObservationsV2Meta`).
 *
 * Differences from the v1 schema:
 * - cursor-based pagination (keyset on start_time + id) instead of page/limit
 * - `fields` field-group selection (default: core + basic)
 * - `expandMetadata` (comma-separated keys that bypass the 200-char truncation)
 * - `parseIoAsJson` (deprecated in the spec; `true` returns a 400 in the route)
 * - `isRootObservation` boolean query parameter
 */
import { ObservationLevel, optionalJsonParam, singleFilter } from "@peri-fuse/shared";
import { stringDateTime } from "@peri-fuse/shared/src/server";
import { z } from "zod";

const ObservationType = z.enum([
  "GENERATION",
  "SPAN",
  "EVENT",
  "AGENT",
  "TOOL",
  "CHAIN",
  "RETRIEVER",
  "EVALUATOR",
  "EMBEDDING",
  "GUARDRAIL",
]);

/**
 * Field groups supported by the `fields` query parameter (spec order).
 * `core` is always included in the response regardless of selection.
 */
export const OBSERVATION_V2_FIELD_GROUPS = [
  "core",
  "basic",
  "time",
  "io",
  "metadata",
  "model",
  "usage",
  "prompt",
  "metrics",
  "trace_context",
] as const;
export type ObservationV2FieldGroup = (typeof OBSERVATION_V2_FIELD_GROUPS)[number];

/**
 * Boolean query parameter: accepts "true"/"false" strings (URL query values)
 * as well as native booleans, and stays `undefined` when absent.
 */
const booleanQueryParam = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .nullish()
  .transform((val) => {
    if (val === undefined || val === null) return undefined;
    return val === "true" || val === true;
  });

/**
 * `expandMetadata` is a comma-separated list of metadata keys whose values are
 * returned untruncated. The special values "true" / "*" expand every key.
 */
const expandMetadataQueryParam = z
  .string()
  .nullish()
  .transform((value) => {
    if (!value) return undefined;
    const keys = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (keys.length === 0) return undefined;
    return keys.includes("true") || keys.includes("*") ? "all" : keys;
  });

export const GetObservationsV2Query = z.object({
  fields: z
    .string()
    .nullish()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : undefined,
    )
    .pipe(z.array(z.enum(OBSERVATION_V2_FIELD_GROUPS)).optional()),
  expandMetadata: expandMetadataQueryParam,
  limit: z.preprocess(
    (x) => (x === "" ? undefined : x),
    z.coerce.number().int().min(1).max(1000).default(50),
  ),
  cursor: z.string().nullish(),
  parseIoAsJson: booleanQueryParam,
  name: z.string().nullish(),
  userId: z.string().nullish(),
  sessionId: z.string().nullish(),
  type: ObservationType.nullish(),
  traceId: z.string().nullish(),
  level: z.enum(ObservationLevel).nullish(),
  parentObservationId: z.string().nullish(),
  isRootObservation: booleanQueryParam,
  environment: z.union([z.array(z.string()), z.string()]).nullish(),
  fromStartTime: stringDateTime,
  toStartTime: stringDateTime,
  version: z.string().nullish(),
  filter: optionalJsonParam(z.array(singleFilter), "filter"),
});
