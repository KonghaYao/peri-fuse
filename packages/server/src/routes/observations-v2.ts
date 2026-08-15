/**
 * GET /api/public/v2/observations
 *
 * Cursor-paginated observations list with field-group selection.
 * Implements the v4.10.0 spec contract:
 * - keyset pagination on (start_time, id); meta = { cursor }
 * - `fields` field groups (default core + basic)
 * - `expandMetadata` keys bypass the 200-char metadata truncation
 * - `parseIoAsJson` (deprecated in the spec: setting it to `true` returns a
 *   400 error per the v4.10.0 contract; false/absent passes through)
 * - structured `filter` JSON with the extended lite filter pipeline
 *
 * Data source and shaping mirror the v1 public observations endpoint.
 */

import { prisma } from "@peri-fuse/shared/src/db";
import { models as modelsTable } from "@peri-fuse/shared/src/db/schema/index.js";
import { convertEventsObservation } from "@peri-fuse/shared/src/server";
import Decimal from "decimal.js";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { GetObservationsV2Query, type ObservationV2FieldGroup } from "../schemas/observations-v2";
import {
  generateObservationsV2ForPublicApi,
  type ObservationsV2Cursor,
  observationsV2RenderingProps,
  transformDbToApiObservationV2,
} from "../shaping/observations-v2";

// ─── Cursor encoding (keyset: start_time DESC, id DESC) ─────────────────────

function encodeObservationsV2Cursor(lastStartTime: string, lastId: string): string {
  const payload: ObservationsV2Cursor = { v: 1, lastStartTime, lastId };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Decode a cursor; returns null for malformed payloads (→ HTTP 400). */
function decodeObservationsV2Cursor(cursor: string): ObservationsV2Cursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<ObservationsV2Cursor>;
    if (
      parsed?.v !== 1 ||
      typeof parsed.lastStartTime !== "string" ||
      parsed.lastStartTime.length === 0 ||
      typeof parsed.lastId !== "string" ||
      parsed.lastId.length === 0
    ) {
      return null;
    }
    return parsed as ObservationsV2Cursor;
  } catch {
    return null;
  }
}

const app = new Hono<LiteServerEnv>();

app.get("/api/public/v2/observations", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");

  // `environment` is an array per spec; repeated query parameters surface
  // through Hono's queries(), while query() keeps only the last value.
  const query: Record<string, unknown> = { ...c.req.query() };
  const environmentQueries = c.req.queries("environment");
  if (environmentQueries) query.environment = environmentQueries;

  const parsed = GetObservationsV2Query.safeParse(query);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const q = parsed.data;

  // Spec (v4.10.0): "Deprecated. Setting this to true will return a 400 error."
  if (q.parseIoAsJson === true) {
    return c.json(
      {
        message:
          "parseIoAsJson is deprecated and not supported. Setting it to true returns a 400 error.",
      },
      400,
    );
  }

  let cursor: ObservationsV2Cursor | null = null;
  if (q.cursor) {
    cursor = decodeObservationsV2Cursor(q.cursor);
    if (!cursor) {
      return c.json({ message: "Invalid cursor" }, 400);
    }
  }

  // Field groups: core is always present; default selection is core + basic.
  const fields = new Set<ObservationV2FieldGroup>(q.fields ?? (["core", "basic"] as const));
  const limit = q.limit;

  // Fetch limit+1 rows to detect whether another page exists.
  const records = await generateObservationsV2ForPublicApi({
    projectId: auth.scope.projectId,
    limit: limit + 1,
    cursor,
    name: q.name ?? undefined,
    userId: q.userId ?? undefined,
    sessionId: q.sessionId ?? undefined,
    type: q.type ?? undefined,
    traceId: q.traceId ?? undefined,
    level: q.level ?? undefined,
    parentObservationId: q.parentObservationId ?? undefined,
    isRootObservation: q.isRootObservation,
    environment: q.environment ?? undefined,
    fromStartTime: q.fromStartTime ?? undefined,
    toStartTime: q.toStartTime ?? undefined,
    version: q.version ?? undefined,
    advancedFilters: q.filter,
  });

  const hasMore = records.length > limit;
  const pageRecords = hasMore ? records.slice(0, limit) : records;

  // Model prices (same flow as the v1 endpoint; in lite mode
  // internalModelId is always null so models stay empty).
  const uniqueModels: string[] = Array.from(
    new Set(pageRecords.map((r) => r.internal_model_id).filter((r): r is string => Boolean(r))),
  );

  const models =
    uniqueModels.length > 0
      ? await prisma.query.models.findMany({
          where: and(
            inArray(modelsTable.id, uniqueModels),
            or(eq(modelsTable.projectId, auth.scope.projectId), isNull(modelsTable.projectId)),
          ),
          with: {
            prices: true,
          },
        })
      : [];

  // parseIoAsJson=true already returned 400 above, so IO is never JSON-parsed.
  const renderingProps = observationsV2RenderingProps(false);

  const data = pageRecords.map((record) => {
    const observation = convertEventsObservation(record, renderingProps, true);
    const model = models.find((m) => m.id === observation.internalModelId);
    const inputPrice = model?.prices.find((p) => p.usageType === "input")?.price;
    const outputPrice = model?.prices.find((p) => p.usageType === "output")?.price;
    const totalPrice = model?.prices.find((p) => p.usageType === "total")?.price;
    return transformDbToApiObservationV2(
      {
        ...observation,
        inputPrice: inputPrice != null ? new Decimal(inputPrice) : null,
        outputPrice: outputPrice != null ? new Decimal(outputPrice) : null,
        totalPrice: totalPrice != null ? new Decimal(totalPrice) : null,
      },
      {
        fields,
        expandMetadata: q.expandMetadata,
      },
    );
  });

  const last = pageRecords[pageRecords.length - 1];
  return c.json({
    data,
    meta: {
      cursor:
        hasMore && last
          ? encodeObservationsV2Cursor(String(last.start_time), String(last.id))
          : null,
    },
  });
});

export default app;
