/**
 * GET /api/public/observations
 *
 * Simplified port of web/src/pages/api/public/observations/index.ts
 * (legacy observations-table code path only — the events-table path is
 * not used in lite mode).
 */

import { prisma } from "@peri-fuse/shared/src/db";
import { models as modelsTable } from "@peri-fuse/shared/src/db/schema/index.js";
import Decimal from "decimal.js";
import { and, inArray, or, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { GetObservationsV1Query } from "../schemas/observations";
import {
  generateObservationsForPublicApi,
  getObservationsCountForPublicApi,
  transformDbToApiObservation,
} from "../shaping/observations";

const app = new Hono<LiteServerEnv>();

app.get("/api/public/observations", authMiddleware, async (c) => {
  const auth = c.get("auth");

  const parsed = GetObservationsV1Query.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;

  const filterProps = {
    projectId: auth.scope.projectId,
    page: query.page,
    limit: query.limit,
    traceId: query.traceId ?? undefined,
    userId: query.userId ?? undefined,
    level: query.level ?? undefined,
    name: query.name ?? undefined,
    type: query.type ?? undefined,
    environment: query.environment ?? undefined,
    parentObservationId: query.parentObservationId ?? undefined,
    fromStartTime: query.fromStartTime ?? undefined,
    toStartTime: query.toStartTime ?? undefined,
    version: query.version ?? undefined,
    advancedFilters: query.filter,
  };

  const [items, count] = await Promise.all([
    generateObservationsForPublicApi(filterProps),
    getObservationsCountForPublicApi(filterProps),
  ]);

  const uniqueModels: string[] = Array.from(
    new Set(items.map((r) => r.internalModelId).filter((r): r is string => Boolean(r))),
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

  const finalCount = count ? count : 0;

  return c.json({
    data: items
      .map((i) => {
        const model = models.find((m) => m.id === i.internalModelId);
        const inputPrice = model?.prices.find((p) => p.usageType === "input")?.price;
        const outputPrice = model?.prices.find((p) => p.usageType === "output")?.price;
        const totalPrice = model?.prices.find((p) => p.usageType === "total")?.price;
        return {
          ...i,
          modelId: model?.id ?? null,
          inputPrice: inputPrice != null ? new Decimal(inputPrice) : null,
          outputPrice: outputPrice != null ? new Decimal(outputPrice) : null,
          totalPrice: totalPrice != null ? new Decimal(totalPrice) : null,
        };
      })
      .map(transformDbToApiObservation),
    meta: {
      page: query.page,
      limit: query.limit,
      totalItems: finalCount,
      totalPages: Math.ceil(finalCount / query.limit),
    },
  });
});

export default app;
