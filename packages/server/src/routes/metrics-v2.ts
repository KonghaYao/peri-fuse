/**
 * GET /api/public/v2/metrics
 *
 * Metrics API v2 (langfuse 4.10.0 contract): the `query` parameter is a
 * URL-encoded JSON string whose schema is NOT in the OpenAPI spec (empty
 * object) — the real structure lives in the parameter description only:
 *
 *   { view, dimensions: [{field}], metrics: [{measure, aggregation}],
 *     filters: [...], timeDimension: {granularity}, fromTimestamp,
 *     toTimestamp, orderBy: [{field, direction}], config: {bins, row_limit} }
 *
 * Views: observations / scores-numeric / scores-boolean / scores-categorical.
 * Response: MetricsV2Response { data: [...] } — dimension values keyed by
 * field name, metric values keyed by `<aggregation>_<measure>`
 * (e.g. `count_count`, `avg_value`, `histogram_latency`).
 *
 * Validation: unknown view/dimension/measure/aggregation/filter column → 400;
 * high-cardinality dimensions (id/traceId/userId/sessionId/…) are filter-only
 * (groupBy → 400). Shaping errors surface as InvalidRequestError → 400 via the
 * app.ts onError handler.
 */

import { InvalidRequestError } from "@peri-fuse/shared";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { MetricsV2QuerySchema } from "../schemas/metrics-v2";
import { queryMetricsV2 } from "../shaping/metrics-v2";

const app = new Hono<LiteServerEnv>();

app.get("/api/public/v2/metrics", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const raw = c.req.query("query");
  if (raw === undefined) {
    return c.json({ message: "Invalid request data", error: ["query parameter is required"] }, 400);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InvalidRequestError("Invalid JSON in query parameter");
  }

  const parsed = MetricsV2QuerySchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }

  // queryMetricsV2 throws InvalidRequestError for unknown
  // dimension/measure/aggregation/filter column and high-cardinality groupBy;
  // app.ts onError maps it to 400 { error, message }.
  const body = await queryMetricsV2(projectId, parsed.data);
  return c.json(body);
});

export default app;
