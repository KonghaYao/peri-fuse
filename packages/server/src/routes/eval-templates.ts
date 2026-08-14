/**
 * Eval templates public API.
 *
 * T1: GET /api/public/evals/templates
 * T2: POST /api/public/evals/templates
 * T3: GET /api/public/evals/templates/{templateId}
 * T4: PATCH /api/public/evals/templates/{templateId}
 * T5: DELETE /api/public/evals/templates/{templateId}
 *
 * Contract pending upstream alignment (docs/evals/phase-1-api-compat.md §4.4,
 * R6). `version` is assigned server-side per (projectId, name): new names
 * start at 1, re-creations increment (decision D3); PATCH never changes
 * version. Global templates (projectId = NULL) are readable by every project
 * but cannot be created/updated/deleted through this API (R5) — writes always
 * use the authenticated project.
 */
import {
  CreateEvalTemplateSchema,
  InvalidRequestError,
  LangfuseConflictError,
  LangfuseNotFoundError,
  publicApiPaginationZod,
  toKnownRequestError,
  UpdateEvalTemplateSchema,
} from "@peri-fuse/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import {
  createEvalTemplate,
  dbEvalTemplateToApi,
  deleteEvalTemplate,
  getEvalTemplateById,
  listEvalTemplatesForPublicApi,
  updateEvalTemplate,
} from "../shaping/eval-templates";

const app = new Hono<LiteServerEnv>();

const GetEvalTemplatesQuery = z.object({
  ...publicApiPaginationZod,
});

async function parseJsonBody(c: Context<LiteServerEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InvalidRequestError("Invalid JSON body");
  }
}

// T1 — list
async function listEvalTemplates(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const parsed = GetEvalTemplatesQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const { page, limit } = parsed.data;

  const { items, count } = await listEvalTemplatesForPublicApi({
    projectId: auth.scope.projectId,
    page,
    limit,
  });

  return c.json({
    data: items,
    meta: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) },
  });
}

// T2 — create (server-assigned version, decision D3)
async function createTemplate(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");

  const parsed = CreateEvalTemplateSchema.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }

  try {
    const row = await createEvalTemplate(auth.scope.projectId, parsed.data);
    return c.json(dbEvalTemplateToApi(row));
  } catch (err) {
    throw mapUniqueConflict(err, `Eval template "${parsed.data.name}" already exists`);
  }
}

// T3 — get by id (project-scoped or global, R5)
async function getTemplate(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const templateId = c.req.param("templateId");

  const row = await getEvalTemplateById(auth.scope.projectId, templateId);
  if (!row) {
    throw new LangfuseNotFoundError(`Eval template ${templateId} not found`);
  }
  return c.json(dbEvalTemplateToApi(row));
}

// T4 — patch (project-scoped only; global templates are read-only, R5)
async function patchTemplate(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const templateId = c.req.param("templateId");

  const parsed = UpdateEvalTemplateSchema.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }

  try {
    const row = await updateEvalTemplate(auth.scope.projectId, templateId, parsed.data);
    if (!row) {
      throw new LangfuseNotFoundError(`Eval template ${templateId} not found`);
    }
    return c.json(dbEvalTemplateToApi(row));
  } catch (err) {
    throw mapUniqueConflict(
      err,
      `Eval template "${parsed.data.name}" already exists for this version`,
    );
  }
}

// T5 — delete (project-scoped only; global templates are read-only, R5).
// Referencing eval configs keep eval_template_id = NULL via FK ON DELETE SET NULL.
async function deleteTemplate(c: Context<LiteServerEnv>) {
  const auth = c.get("auth");
  const templateId = c.req.param("templateId");

  const row = await deleteEvalTemplate(auth.scope.projectId, templateId);
  if (!row) {
    throw new LangfuseNotFoundError(`Eval template ${templateId} not found`);
  }
  return c.body(null, 204);
}

/** Map a SQLite unique-constraint violation (P2002) to a 409 conflict. */
function mapUniqueConflict(err: unknown, message: string): unknown {
  const known = toKnownRequestError(err);
  if (known?.code === "P2002") {
    return new LangfuseConflictError(message);
  }
  return err;
}

app.get("/api/public/evals/templates", authMiddleware, responseCache(2_000), listEvalTemplates);
app.post("/api/public/evals/templates", authMiddleware, createTemplate);
app.get(
  "/api/public/evals/templates/:templateId",
  authMiddleware,
  responseCache(2_000),
  getTemplate,
);
app.patch("/api/public/evals/templates/:templateId", authMiddleware, patchTemplate);
app.delete("/api/public/evals/templates/:templateId", authMiddleware, deleteTemplate);

export default app;
