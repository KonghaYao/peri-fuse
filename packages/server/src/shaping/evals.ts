/**
 * Eval config shaping: `job_configurations` rows -> public API shapes.
 *
 * docs/evals/phase-1-api-compat.md §4.3 (E1-E10) — contract pending upstream
 * alignment (R6). Decision D1-B: eval configs live in `job_configurations`
 * (jobType=EVAL), which has NO name/version columns; `name`/`version` are
 * therefore derived here — `name` follows the referenced eval template
 * (fallback: scoreName), `version` is the ordinal of the config among the
 * same-scoreName EVAL configs of the project (oldest = 1).
 */
import type { EvalConfig } from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { type evalTemplates, jobConfigurations } from "@peri-fuse/shared/src/db/schema/index.js";
import { and, count, desc, eq, lt } from "drizzle-orm";

export type EvalConfigRow = typeof jobConfigurations.$inferSelect;
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

/**
 * Ordinal (1-based) of each row within its same-scoreName group, ordered by
 * createdAt ascending. Callers pass the already-fetched page rows.
 */
export function computeEvalConfigVersions(
  rows: { id: string; scoreName: string; createdAt: Date }[],
): Map<string, number> {
  const groups = new Map<string, { id: string; createdAt: Date }[]>();
  for (const row of rows) {
    const group = groups.get(row.scoreName) ?? [];
    group.push({ id: row.id, createdAt: row.createdAt });
    groups.set(row.scoreName, group);
  }
  const versions = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    group.forEach((row, index) => versions.set(row.id, index + 1));
  }
  return versions;
}

/** 1-based ordinal of a single config within its same-scoreName group. */
export async function getEvalConfigVersion(
  projectId: string,
  scoreName: string,
  createdAt: Date,
): Promise<number> {
  const earlier = await prisma
    .select({ value: count() })
    .from(jobConfigurations)
    .where(
      and(
        eq(jobConfigurations.projectId, projectId),
        eq(jobConfigurations.jobType, "EVAL"),
        eq(jobConfigurations.scoreName, scoreName),
        lt(jobConfigurations.createdAt, createdAt),
      ),
    )
    .then((rows) => rows[0]?.value ?? 0);
  return earlier + 1;
}

export function dbEvalConfigToApi(
  row: EvalConfigRow,
  version: number,
  template: EvalTemplateRow | null,
): EvalConfig {
  return {
    id: row.id,
    // Derived: job_configurations has no name column (D1-B). The referenced
    // template names the config in upstream UI semantics; fall back to the
    // score name when no template is linked.
    name: template?.name ?? row.scoreName,
    version,
    scoreName: row.scoreName,
    targetObject: row.targetObject as EvalConfig["targetObject"],
    filter: parseJsonArray(row.filter),
    variableMapping: parseJsonObject(row.variableMapping),
    sampling: row.sampling,
    delay: row.delay,
    timeScope: parseJsonArray(row.timeScope) as string[],
    status: row.status as EvalConfig["status"],
    evalTemplateId: row.evalTemplateId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    projectId: row.projectId,
  };
}

export async function getEvalConfigById(
  projectId: string,
  configId: string,
): Promise<{ row: EvalConfigRow; template: EvalTemplateRow | null } | null> {
  const row = await prisma.query.jobConfigurations.findFirst({
    where: and(
      eq(jobConfigurations.id, configId),
      eq(jobConfigurations.projectId, projectId),
      eq(jobConfigurations.jobType, "EVAL"),
    ),
    with: { evalTemplate: true },
  });
  return row ? { row, template: row.evalTemplate ?? null } : null;
}

export async function listEvalConfigsForPublicApi(params: {
  projectId: string;
  page: number;
  limit: number;
  scoreName?: string;
}): Promise<{ items: EvalConfig[]; count: number }> {
  const { projectId, page, limit, scoreName } = params;
  const where = and(
    eq(jobConfigurations.projectId, projectId),
    eq(jobConfigurations.jobType, "EVAL"),
    scoreName !== undefined ? eq(jobConfigurations.scoreName, scoreName) : undefined,
  );

  const [rows, total] = await Promise.all([
    prisma.query.jobConfigurations.findMany({
      where,
      orderBy: [desc(jobConfigurations.createdAt)],
      limit,
      offset: (page - 1) * limit,
      with: { evalTemplate: true },
    }),
    prisma
      .select({ value: count() })
      .from(jobConfigurations)
      .where(where)
      .then((countRows) => countRows[0]?.value ?? 0),
  ]);

  const versions = computeEvalConfigVersions(rows);
  return {
    items: rows.map((row) =>
      dbEvalConfigToApi(row, versions.get(row.id) ?? 1, row.evalTemplate ?? null),
    ),
    count: total,
  };
}
