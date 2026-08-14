/**
 * Eval configs public API.
 *
 * E1/E2: GET/POST /api/public/evals (E3/E4 alias: /api/public/evals/configs)
 * E5-E7: GET/PATCH/DELETE /api/public/evals/configs/{configId}
 *         (E8-E10 alias: /api/public/evals/{configId})
 *
 * Contract pending upstream alignment (docs/evals/phase-1-api-compat.md §4.3,
 * R6). Backed by `job_configurations` (jobType=EVAL) per decision D1-B — no
 * `eval_configs` table. Same-name (same scoreName) creates increment
 * `version`; `name`/`version` are derived at the shaping layer because the
 * table has no such columns (see shaping/evals.ts).
 */
import { randomUUID } from "node:crypto";
import {
  CreateEvalConfigSchema,
  InvalidRequestError,
  LangfuseNotFoundError,
  publicApiPaginationZod,
  UpdateEvalConfigSchema,
} from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { evalTemplates, jobConfigurations } from "@peri-fuse/shared/src/db/schema/index.js";
import { and, count, eq, isNull, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import {
  dbEvalConfigToApi,
  getEvalConfigById,
  getEvalConfigVersion,
  listEvalConfigsForPublicApi,
} from "../shaping/evals";

const app = new Hono<LiteServerEnv>();

const GetEvalConfigsQuery = z.object({
  ...publicApiPaginationZod,
  scoreName: z.string().optional(),
});

async function parseJsonBody(c: Context<LiteServerEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InvalidRequestError("Invalid JSON body");
  }
}

/** Validate that a referenced eval template exists and belongs to the project (or is global). */
async function findVisibleTemplate(projectId: string, templateId: string) {
  return prisma.query.evalTemplates.findFirst({
    where: and(
      eq(evalTemplates.id, templateId),
      or(eq(evalTemplates.projectId, projectId), isNull(evalTemplates.projectId)),
    ),
  });
}

// E1 / E3 — list
async function listEvalConfigs(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const parsed = GetEvalConfigsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { page, limit, scoreName } = parsed.data;

  const { items, count } = await listEvalConfigsForPublicApi({
    projectId: auth.scope.projectId,
    page,
    limit,
    scoreName,
  });

  return c.json({
    data: items,
    meta: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) },
  });
}

// E2 / E4 — create
async function createEvalConfig(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const parsed = CreateEvalConfigSchema.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const data = parsed.data;

  // Validate the template reference (project-scoped or global) → 404.
  let template = null;
  if (data.evalTemplateId) {
    template = await findVisibleTemplate(projectId, data.evalTemplateId);
    if (!template) {
      throw new LangfuseNotFoundError(`Eval template ${data.evalTemplateId} not found`);
    }
  }

  // Same-name (same scoreName) creates increment version; new names start at 1.
  const existing = await prisma
    .select({ value: count() })
    .from(jobConfigurations)
    .where(
      and(
        eq(jobConfigurations.projectId, projectId),
        eq(jobConfigurations.jobType, "EVAL"),
        eq(jobConfigurations.scoreName, data.scoreName),
      ),
    )
    .then((rows) => rows[0]?.value ?? 0);

  const row = await prisma
    .insert(jobConfigurations)
    .values({
      id: randomUUID(),
      projectId,
      jobType: "EVAL",
      status: data.status,
      evalTemplateId: data.evalTemplateId ?? null,
      scoreName: data.scoreName,
      filter: JSON.stringify(data.filter),
      targetObject: data.targetObject,
      variableMapping: JSON.stringify(data.variableMapping),
      sampling: data.sampling,
      delay: data.delay,
      timeScope: JSON.stringify(data.timeScope),
    })
    .returning()
    .then((rows) => rows[0]);

  return c.json(dbEvalConfigToApi(row, existing + 1, template));
}

// E5 / E8 — get by id
async function getEvalConfig(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const configId = c.req.param("configId");

  const found = await getEvalConfigById(auth.scope.projectId, configId);
  if (!found) {
    throw new LangfuseNotFoundError(`Eval config ${configId} not found`);
  }

  const version = await getEvalConfigVersion(
    auth.scope.projectId,
    found.row.scoreName,
    found.row.createdAt,
  );
  return c.json(dbEvalConfigToApi(found.row, version, found.template));
}

// E6 / E9 — patch by id (never changes `version`, which is derived)
async function patchEvalConfig(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const configId = c.req.param("configId");

  const parsed = UpdateEvalConfigSchema.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const data = parsed.data;

  const existing = await getEvalConfigById(projectId, configId);
  if (!existing) {
    throw new LangfuseNotFoundError(`Eval config ${configId} not found`);
  }

  let template = existing.template;
  if (data.evalTemplateId !== undefined && data.evalTemplateId !== null) {
    template = await findVisibleTemplate(projectId, data.evalTemplateId);
    if (!template) {
      throw new LangfuseNotFoundError(`Eval template ${data.evalTemplateId} not found`);
    }
  }

  const set: Partial<typeof jobConfigurations.$inferInsert> = {};
  if (data.scoreName !== undefined) set.scoreName = data.scoreName;
  if (data.targetObject !== undefined) set.targetObject = data.targetObject;
  if (data.filter !== undefined) set.filter = JSON.stringify(data.filter);
  if (data.variableMapping !== undefined)
    set.variableMapping = JSON.stringify(data.variableMapping);
  if (data.sampling !== undefined) set.sampling = data.sampling;
  if (data.delay !== undefined) set.delay = data.delay;
  if (data.timeScope !== undefined) set.timeScope = JSON.stringify(data.timeScope);
  if (data.status !== undefined) set.status = data.status;
  if (data.evalTemplateId !== undefined) set.evalTemplateId = data.evalTemplateId;

  const row = await prisma
    .update(jobConfigurations)
    .set(set)
    .where(and(eq(jobConfigurations.id, configId), eq(jobConfigurations.projectId, projectId)))
    .returning()
    .then((rows) => rows[0]);

  const version = await getEvalConfigVersion(projectId, row.scoreName, row.createdAt);
  return c.json(dbEvalConfigToApi(row, version, template));
}

// E7 / E10 — delete by id
async function deleteEvalConfig(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const configId = c.req.param("configId");

  const deleted = await prisma
    .delete(jobConfigurations)
    .where(
      and(
        eq(jobConfigurations.id, configId),
        eq(jobConfigurations.projectId, auth.scope.projectId),
      ),
    )
    .returning()
    .then((rows) => rows[0]);
  if (!deleted) {
    throw new LangfuseNotFoundError(`Eval config ${configId} not found`);
  }
  return c.body(null, 204);
}

app.get("/api/public/evals", authMiddleware, responseCache(2_000), listEvalConfigs);
app.get("/api/public/evals/configs", authMiddleware, responseCache(2_000), listEvalConfigs);
app.post("/api/public/evals", authMiddleware, createEvalConfig);
app.post("/api/public/evals/configs", authMiddleware, createEvalConfig);
app.get("/api/public/evals/configs/:configId", authMiddleware, responseCache(2_000), getEvalConfig);
app.get("/api/public/evals/:configId", authMiddleware, responseCache(2_000), getEvalConfig);
app.patch("/api/public/evals/configs/:configId", authMiddleware, patchEvalConfig);
app.patch("/api/public/evals/:configId", authMiddleware, patchEvalConfig);
app.delete("/api/public/evals/configs/:configId", authMiddleware, deleteEvalConfig);
app.delete("/api/public/evals/:configId", authMiddleware, deleteEvalConfig);

export default app;
