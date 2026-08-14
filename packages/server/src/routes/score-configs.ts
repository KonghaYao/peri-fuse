/**
 * Score configs public API (S1-S4).
 *
 * GET/POST /api/public/score-configs and GET/PATCH /api/public/score-configs/:configId.
 * Simplified port of web/src/pages/api/public/score-configs/index.ts and
 * [configId].ts (phase-1-api-compat.md §4.1). Upstream has no DELETE endpoint —
 * configs are archived via PATCH { isArchived: true } (decision D2).
 *
 * Request schemas are defined here (not in shared) because the shared
 * domain layer only exposes DB-read validation; the Create/Update request
 * schemas reuse its building blocks (ScoreConfigNameSchema, category
 * validation, numeric-range refinement).
 */

import { randomUUID } from "node:crypto";
import {
  BooleanConfigFields,
  InvalidRequestError,
  LangfuseNotFoundError,
  publicApiPaginationZod,
  ScoreConfigCategory,
  type ScoreConfig as ScoreConfigDbType,
  ScoreConfigNameSchema,
  validateCategories,
  validateNumericRangeFields,
} from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { scoreConfigs } from "@peri-fuse/shared/src/db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import {
  dbScoreConfigToApi,
  listScoreConfigsForPublicApi,
  type ScoreConfigApi,
} from "../shaping/score-configs";

const app = new Hono<LiteServerEnv>();

const ScoreConfigsListQuerySchema = z.object({
  ...publicApiPaginationZod,
});

// categories are required for CATEGORICAL/BOOLEAN and forbidden for
// NUMERIC/TEXT; BOOLEAN must be exactly [True/1, False/0] (mirrors the
// BooleanConfigFields semantics from domain/score-configs.ts).
const CreateScoreConfigSchema = z
  .discriminatedUnion("dataType", [
    z.object({
      name: ScoreConfigNameSchema,
      dataType: z.literal("NUMERIC"),
      categories: z.undefined().nullish(),
      minValue: z.number().nullish(),
      maxValue: z.number().nullish(),
      description: z.string().nullish(),
    }),
    z.object({
      name: ScoreConfigNameSchema,
      dataType: z.literal("BOOLEAN"),
      categories: BooleanConfigFields.shape.categories,
      minValue: z.number().nullish(),
      maxValue: z.number().nullish(),
      description: z.string().nullish(),
    }),
    z.object({
      name: ScoreConfigNameSchema,
      dataType: z.literal("CATEGORICAL"),
      categories: z.array(ScoreConfigCategory).min(1).superRefine(validateCategories),
      minValue: z.undefined().nullish(),
      maxValue: z.undefined().nullish(),
      description: z.string().nullish(),
    }),
    z.object({
      name: ScoreConfigNameSchema,
      dataType: z.literal("TEXT"),
      categories: z.undefined().nullish(),
      minValue: z.undefined().nullish(),
      maxValue: z.undefined().nullish(),
      description: z.string().nullish(),
    }),
  ])
  .superRefine(validateNumericRangeFields);

// All fields optional; dataType itself is immutable. Data-type-dependent
// consistency (categories/min/max vs. the existing config's dataType) is
// enforced in validateUpdateAgainstConfig below.
const UpdateScoreConfigSchema = z.object({
  isArchived: z.boolean().nullish(),
  name: ScoreConfigNameSchema.nullish(),
  categories: z.array(ScoreConfigCategory).nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
  description: z.string().nullish(),
});

type UpdateScoreConfig = z.infer<typeof UpdateScoreConfigSchema>;

const validateUpdateAgainstConfig = (
  update: UpdateScoreConfig,
  config: ScoreConfigDbType,
): void => {
  const { categories, minValue, maxValue } = update;
  const dataType = config.dataType as ScoreConfigApi["dataType"];

  if (categories !== undefined && categories !== null) {
    if (dataType !== "CATEGORICAL" && dataType !== "BOOLEAN") {
      throw new InvalidRequestError(
        `Categories are only allowed for CATEGORICAL or BOOLEAN score configs, not ${dataType}`,
      );
    }
    const categoriesSchema =
      dataType === "BOOLEAN"
        ? BooleanConfigFields.shape.categories
        : z.array(ScoreConfigCategory).min(1).superRefine(validateCategories);
    const parsed = categoriesSchema.safeParse(categories);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => issue.message).join(", ");
      throw new InvalidRequestError(`Invalid categories for ${dataType} score config: ${details}`);
    }
  } else if (categories === null && (dataType === "CATEGORICAL" || dataType === "BOOLEAN")) {
    throw new InvalidRequestError(`Categories cannot be cleared for ${dataType} score configs`);
  }

  if (minValue !== undefined || maxValue !== undefined) {
    if (dataType !== "NUMERIC") {
      throw new InvalidRequestError(
        `minValue/maxValue are only allowed for NUMERIC score configs, not ${dataType}`,
      );
    }
    if (minValue !== undefined && maxValue !== undefined && maxValue <= minValue) {
      throw new InvalidRequestError("Maximum value must be greater than Minimum value");
    }
  }
};

const getConfigRow = async (projectId: string, configId: string): Promise<ScoreConfigDbType> => {
  const config = await prisma
    .select()
    .from(scoreConfigs)
    .where(and(eq(scoreConfigs.id, configId), eq(scoreConfigs.projectId, projectId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!config) {
    throw new LangfuseNotFoundError(`Score config ${configId} not found within authorized project`);
  }
  return config;
};

app.get("/api/public/score-configs", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");

  const parsed = ScoreConfigsListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { page, limit } = parsed.data;

  const result = await listScoreConfigsForPublicApi({
    projectId: auth.scope.projectId,
    page,
    limit,
  });
  return c.json(result, 200);
});

app.post("/api/public/score-configs", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ message: "Invalid request data", errors: ["Invalid JSON body"] }, 400);
  }

  const parsed = CreateScoreConfigSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { name, dataType, categories, minValue, maxValue, description } = parsed.data;

  const id = randomUUID();
  await prisma.insert(scoreConfigs).values({
    id,
    projectId,
    name,
    dataType,
    isArchived: false,
    minValue: minValue ?? null,
    maxValue: maxValue ?? null,
    categories: categories ? JSON.stringify(categories) : null,
    description: description ?? null,
  });

  const created = await getConfigRow(projectId, id);
  return c.json(dbScoreConfigToApi(created), 200);
});

app.get("/api/public/score-configs/:configId", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");
  const config = await getConfigRow(auth.scope.projectId, c.req.param("configId"));
  return c.json(dbScoreConfigToApi(config), 200);
});

app.patch("/api/public/score-configs/:configId", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const configId = c.req.param("configId");

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ message: "Invalid request data", errors: ["Invalid JSON body"] }, 400);
  }

  const parsed = UpdateScoreConfigSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const update = parsed.data;

  const existing = await getConfigRow(projectId, configId);
  validateUpdateAgainstConfig(update, existing);

  const patch: Partial<typeof scoreConfigs.$inferInsert> = {};
  if (update.isArchived !== undefined) patch.isArchived = update.isArchived;
  if (update.name !== undefined) patch.name = update.name;
  if (update.categories !== undefined) {
    patch.categories = update.categories === null ? null : JSON.stringify(update.categories);
  }
  if (update.minValue !== undefined) patch.minValue = update.minValue;
  if (update.maxValue !== undefined) patch.maxValue = update.maxValue;
  if (update.description !== undefined) patch.description = update.description;

  await prisma
    .update(scoreConfigs)
    .set(patch)
    .where(and(eq(scoreConfigs.id, configId), eq(scoreConfigs.projectId, projectId)));

  const updated = await getConfigRow(projectId, configId);
  return c.json(dbScoreConfigToApi(updated), 200);
});

export default app;
