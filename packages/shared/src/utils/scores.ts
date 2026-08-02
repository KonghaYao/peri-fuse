import { z } from "zod";

/**
 * Zod v4's `z.discriminatedUnion` no longer matches a `z.undefined()`
 * discriminator branch when the discriminated field is absent. Upstream
 * Langfuse (Zod v3) relies on exactly that fallback branch to accept scores
 * sent without an explicit `dataType` — the single most common SDK usage
 * (`langfuse.score({ name, value, traceId })`). Under Zod v4 such scores are
 * rejected with a 400, breaking SDK compatibility.
 *
 * This wrapper restores the behaviour: before the discriminated union parses,
 * a missing `dataType` is inferred from the value's type, mirroring
 * `inferDataType()` in validateAndInflateScore.ts (number → NUMERIC,
 * otherwise → CATEGORICAL). Wrap the score `z.discriminatedUnion("dataType", …)`
 * with this so both the ingestion and public-API score schemas stay consistent.
 */
export const withInferredScoreDataType = <T extends z.ZodType>(union: T) =>
  z.preprocess((val) => {
    if (
      val !== null &&
      typeof val === "object" &&
      (val as { dataType?: unknown }).dataType === undefined
    ) {
      const value = (val as { value?: unknown }).value;
      return {
        ...(val as Record<string, unknown>),
        dataType: typeof value === "number" ? "NUMERIC" : "CATEGORICAL",
      };
    }
    return val;
  }, union);

export const applyScoreValidation = <T extends z.ZodType<any, any, any>>(schema: T) => {
  return schema.refine(
    (data) => {
      const hasTraceId = !!data.traceId;
      const hasSessionId = !!data.sessionId;
      const hasDatasetRunId = !!data.datasetRunId;

      return (
        (hasTraceId && !hasSessionId && !hasDatasetRunId) ||
        (hasSessionId && !hasTraceId && !hasDatasetRunId && !data.observationId) ||
        (hasDatasetRunId && !hasTraceId && !hasSessionId && !data.observationId)
      );
    },
    {
      message:
        "Provide exactly one of the following: traceId (with optional observationId), sessionId or datasetRunId. ObservationId requires traceId.",
      path: ["traceId", "sessionId", "datasetRunId", "observationId"],
    },
  );
};
