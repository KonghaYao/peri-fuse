/**
 * Query schemas for the traces endpoints.
 * Ported from web/src/features/public-api/types/traces.ts (GET schemas only).
 */
import {
  commaSeparatedEnumArray,
  optionalJsonParam,
  orderBy,
  publicApiPaginationZod,
  singleFilter,
} from "@langfuse-lite/shared";
import { useEventsTableSchema } from "@langfuse-lite/shared/query";
import { stringDateTime, TRACE_FIELD_GROUPS } from "@langfuse-lite/shared/src/server";
import { z } from "zod";

// GET /api/public/traces
export const GetTracesV1Query = z.object({
  ...publicApiPaginationZod,
  userId: z.string().nullish(),
  name: z.string().nullish(),
  tags: z.union([z.array(z.string()), z.string()]).nullish(),
  environment: z.union([z.array(z.string()), z.string()]).nullish(),
  sessionId: z.string().nullish(),
  version: z.string().nullish(),
  release: z.string().nullish(),
  fromTimestamp: stringDateTime,
  toTimestamp: stringDateTime,
  orderBy: z
    .string() // orderBy=timestamp.asc
    .nullish()
    .transform((v) => {
      if (!v) return null;
      const [column, order] = v.split(".");
      return { column, order: order?.toUpperCase() };
    })
    .pipe(orderBy.nullable()),
  fields: commaSeparatedEnumArray(TRACE_FIELD_GROUPS, null, {
    unknownValues: "filter",
  }).transform((fields) => (fields && fields.length > 0 ? fields : null)),
  useEventsTable: useEventsTableSchema,
  filter: optionalJsonParam(z.array(singleFilter), "filter"),
});

// GET /api/public/traces/{traceId}
export const GetTraceV1Query = z.object({
  traceId: z.string(),
  fields: commaSeparatedEnumArray(TRACE_FIELD_GROUPS, null, {
    unknownValues: "filter",
  }).transform((fields) => (fields && fields.length > 0 ? fields : null)),
});
