/**
 * Query schemas for the observations endpoints.
 * Ported from web/src/features/public-api/types/observations.ts (GET schema only).
 */
import {
  ObservationLevel,
  optionalJsonParam,
  publicApiPaginationZod,
  singleFilter,
} from "@peri-fuse/shared";
import { useEventsTableSchema } from "@peri-fuse/shared/query";
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

// GET /api/public/observations
export const GetObservationsV1Query = z.object({
  ...publicApiPaginationZod,
  type: ObservationType.nullish(),
  name: z.string().nullish(),
  userId: z.string().nullish(),
  level: z.enum(ObservationLevel).nullish(),
  traceId: z.string().nullish(),
  version: z.string().nullish(),
  parentObservationId: z.string().nullish(),
  environment: z.union([z.array(z.string()), z.string()]).nullish(),
  fromStartTime: stringDateTime,
  toStartTime: stringDateTime,
  useEventsTable: useEventsTableSchema,
  filter: optionalJsonParam(z.array(singleFilter), "filter"),
});
