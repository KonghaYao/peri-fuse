/**
 * GET /api/public/observations
 *
 * Simplified port of web/src/pages/api/public/observations/index.ts
 * (legacy observations-table code path only — the events-table path is
 * not used in lite mode).
 */

import { prisma } from "@peri-fuse/shared/src/db";
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
      ? await prisma.model.findMany({
          where: {
            id: {
              in: uniqueModels,
            },
            OR: [{ projectId: auth.scope.projectId }, { projectId: null }],
          },
          include: {
            Price: true,
          },
        })
      : [];

  const finalCount = count ? count : 0;

  return c.json({
    data: items
      .map((i) => {
        const model = models.find((m) => m.id === i.internalModelId);
        return {
          ...i,
          modelId: model?.id ?? null,
          inputPrice: model?.Price?.find((m) => m.usageType === "input")?.price ?? null,
          outputPrice: model?.Price?.find((m) => m.usageType === "output")?.price ?? null,
          totalPrice: model?.Price?.find((m) => m.usageType === "total")?.price ?? null,
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
