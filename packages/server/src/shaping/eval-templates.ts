/**
 * Eval template shaping: `eval_templates` rows -> public API shapes.
 *
 * docs/evals/phase-1-api-compat.md §4.4 (T1-T5) — contract pending upstream
 * alignment (R6). Global templates (projectId = NULL) are visible to every
 * project (R5); writes always use the authenticated project.
 */
import { randomUUID } from "node:crypto";
import type {
  CreateEvalTemplateRequest,
  EvalTemplate,
  UpdateEvalTemplateRequest,
} from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { evalTemplates } from "@peri-fuse/shared/src/db/schema/index.js";
import { and, count, desc, eq, isNull, max, or } from "drizzle-orm";

export type EvalTemplateRow = typeof evalTemplates.$inferSelect;

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function dbEvalTemplateToApi(row: EvalTemplateRow): EvalTemplate {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    prompt: row.prompt ?? undefined,
    type: row.type as EvalTemplate["type"],
    partner: row.partner ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    modelParams: row.modelParams === null ? undefined : parseJsonObject(row.modelParams),
    vars: parseJsonArray(row.vars) as string[],
    outputSchema: row.outputSchema === null ? undefined : JSON.parse(row.outputSchema),
    sourceCode: row.sourceCode ?? undefined,
    sourceCodeLanguage: (row.sourceCodeLanguage ?? undefined) as EvalTemplate["sourceCodeLanguage"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    projectId: row.projectId ?? undefined,
  };
}

/**
 * Visible to the authenticated project: project-scoped templates plus global
 * ones (projectId = NULL) — docs/evals/phase-1-api-compat.md §7 R5.
 */
export async function getEvalTemplateById(
  projectId: string,
  templateId: string,
): Promise<EvalTemplateRow | null> {
  return prisma.query.evalTemplates.findFirst({
    where: and(
      eq(evalTemplates.id, templateId),
      or(eq(evalTemplates.projectId, projectId), isNull(evalTemplates.projectId)),
    ),
  });
}

export async function listEvalTemplatesForPublicApi(params: {
  projectId: string;
  page: number;
  limit: number;
}): Promise<{ items: EvalTemplate[]; count: number }> {
  const { projectId, page, limit } = params;
  const where = or(eq(evalTemplates.projectId, projectId), isNull(evalTemplates.projectId));

  const [rows, total] = await Promise.all([
    prisma.query.evalTemplates.findMany({
      where,
      orderBy: [desc(evalTemplates.createdAt)],
      limit,
      offset: (page - 1) * limit,
    }),
    prisma
      .select({ value: count() })
      .from(evalTemplates)
      .where(where)
      .then((countRows) => countRows[0]?.value ?? 0),
  ]);

  return { items: rows.map(dbEvalTemplateToApi), count: total };
}

/**
 * Server-assigned versioning (decision D3): per (projectId, name), new names
 * start at 1 and re-creations increment. Global (NULL project) templates do
 * not participate in the increment.
 */
export async function getNextEvalTemplateVersion(projectId: string, name: string): Promise<number> {
  const latest = await prisma
    .select({ value: max(evalTemplates.version) })
    .from(evalTemplates)
    .where(and(eq(evalTemplates.projectId, projectId), eq(evalTemplates.name, name)))
    .then((rows) => rows[0]?.value);
  return (latest ?? 0) + 1;
}

export async function createEvalTemplate(
  projectId: string,
  data: CreateEvalTemplateRequest,
): Promise<EvalTemplateRow> {
  const version = await getNextEvalTemplateVersion(projectId, data.name);
  const row = await prisma
    .insert(evalTemplates)
    .values({
      id: randomUUID(),
      projectId,
      name: data.name,
      version,
      prompt: data.prompt ?? null,
      type: data.type,
      partner: data.partner ?? null,
      model: data.model ?? null,
      provider: data.provider ?? null,
      modelParams: data.modelParams === undefined ? null : JSON.stringify(data.modelParams),
      vars: JSON.stringify(data.vars),
      outputSchema: data.outputSchema === undefined ? null : JSON.stringify(data.outputSchema),
      sourceCode: data.sourceCode ?? null,
      sourceCodeLanguage: data.sourceCodeLanguage ?? null,
    })
    .returning()
    .then((rows) => rows[0]);
  return row;
}

/**
 * Update a project-scoped template. `version` is never changed by PATCH
 * (versioning is create-only, decision D3). Returns null when the template is
 * missing or not owned by the project (global templates are read-only).
 */
export async function updateEvalTemplate(
  projectId: string,
  templateId: string,
  data: UpdateEvalTemplateRequest,
): Promise<EvalTemplateRow | null> {
  const set: Partial<EvalTemplateRow> = {};
  if (data.name !== undefined) set.name = data.name;
  if (data.prompt !== undefined) set.prompt = data.prompt ?? null;
  if (data.type !== undefined) set.type = data.type;
  if (data.partner !== undefined) set.partner = data.partner ?? null;
  if (data.model !== undefined) set.model = data.model ?? null;
  if (data.provider !== undefined) set.provider = data.provider ?? null;
  if (data.modelParams !== undefined) {
    set.modelParams = data.modelParams === null ? null : JSON.stringify(data.modelParams);
  }
  if (data.vars !== undefined) set.vars = JSON.stringify(data.vars);
  if (data.outputSchema !== undefined) {
    set.outputSchema = data.outputSchema === null ? null : JSON.stringify(data.outputSchema);
  }
  if (data.sourceCode !== undefined) set.sourceCode = data.sourceCode ?? null;
  if (data.sourceCodeLanguage !== undefined) {
    set.sourceCodeLanguage = data.sourceCodeLanguage ?? null;
  }

  return prisma
    .update(evalTemplates)
    .set(set)
    .where(and(eq(evalTemplates.id, templateId), eq(evalTemplates.projectId, projectId)))
    .returning()
    .then((rows) => rows[0] ?? null);
}

/**
 * Delete a project-scoped template. Global templates cannot be deleted (R5).
 * Referencing eval configs keep the FK `eval_template_id` ON DELETE SET NULL
 * (schema.ts:674), so no explicit cleanup is needed.
 */
export async function deleteEvalTemplate(
  projectId: string,
  templateId: string,
): Promise<EvalTemplateRow | null> {
  return prisma
    .delete(evalTemplates)
    .where(and(eq(evalTemplates.id, templateId), eq(evalTemplates.projectId, projectId)))
    .returning()
    .then((rows) => rows[0] ?? null);
}
