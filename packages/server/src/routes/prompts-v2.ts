/**
 * v2 prompts public API (spec v4.10.0) — official semantics, review-verified:
 *
 *  - Version selection: `version` XOR `label` (default "production");
 *    specifying both → 400 "Cannot specify both". `isActive` is a DERIVED
 *    response field (labels contain "production") and never selects versions.
 *  - `resolve` (default true) resolves prompt dependencies and returns
 *    `resolutionGraph`; it is NOT a version-selection parameter.
 *  - POST: server assigns version (max+1 per name, 1 if none); the new
 *    version always carries the `latest` label; provided labels are removed
 *    from other versions (project-wide uniqueness); same name with a
 *    different type → 400; unique-constraint race → 400. The DB `prompt`
 *    column stores `JSON.stringify({ prompt })`.
 *  - PATCH {name}/versions/{version}: body is `newLabels` only (required,
 *    whole-array replacement; `latest` stays system-managed).
 *  - DELETE: no label/version → all versions of the name, 204 no body;
 *    label filter uses labels-contains semantics.
 */

import { randomUUID } from "node:crypto";
import { InvalidRequestError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { prisma, toKnownRequestError } from "@peri-fuse/shared/src/db";
import { promptDependencies, prompts } from "@peri-fuse/shared/src/db/schema/index.js";
import { escapeSqlLikePattern } from "@peri-fuse/shared/src/server";
import { and, desc, eq, gte, inArray, like, lt, max, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import {
  CreatePromptSchema,
  DeletePromptV2Query,
  GetPromptV2Query,
  ListPromptsV2Query,
  PatchPromptVersionBody,
} from "../schemas/prompts-v2";
import {
  extractDependencies,
  findPromptVersion,
  type PromptResolutionGraph,
  type PromptRow,
  parseJsonArray,
  parseStoredPrompt,
  promptNotFoundMessage,
  resolvePromptDependencies,
  toPromptMetaV2Api,
  toPromptV2Api,
} from "../shaping/prompts-v2";

const app = new Hono<LiteServerEnv>();

async function readJsonBody(c: Context<LiteServerEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** JSON-array `labels`/`tags` column contains a value (SQLite JSON string). */
function jsonArrayContains(column: typeof prompts.labels | typeof prompts.tags, value: string) {
  return like(column, `%"${escapeSqlLikePattern(value)}"%`);
}

function invalidQuery(c: Context<LiteServerEnv>, issues: z.ZodIssue[]) {
  return c.json({ message: "Invalid request data", error: issues }, 400);
}

// ---------------------------------------------------------------------------
// GET /api/public/v2/prompts — PromptMetaListResponse (no `prompt` field)
// ---------------------------------------------------------------------------

app.get("/api/public/v2/prompts", authMiddleware, responseCache(2_000), async (c) => {
  const parsed = ListPromptsV2Query.safeParse(c.req.query());
  if (!parsed.success) return invalidQuery(c, parsed.error.issues);
  const { page, limit, name, label, tag, fromUpdatedAt, toUpdatedAt } = parsed.data;
  const projectId = c.get("auth").scope.projectId;

  const conditions = [eq(prompts.projectId, projectId)];
  if (name) conditions.push(eq(prompts.name, name));
  if (label) conditions.push(jsonArrayContains(prompts.labels, label));
  if (tag) conditions.push(jsonArrayContains(prompts.tags, tag));
  if (fromUpdatedAt) conditions.push(gte(prompts.updatedAt, new Date(fromUpdatedAt)));
  if (toUpdatedAt) conditions.push(lt(prompts.updatedAt, new Date(toUpdatedAt)));

  const rows = await prisma
    .select()
    .from(prompts)
    .where(and(...conditions))
    .orderBy(desc(prompts.updatedAt));

  // Name-level aggregation; rows arrive newest-first, so the first row of each
  // group is the most recent matching version (source of lastConfig).
  const groups = new Map<string, { first: PromptRow; versions: number[]; labels: Set<string> }>();
  for (const row of rows) {
    let group = groups.get(row.name);
    if (!group) {
      group = { first: row, versions: [], labels: new Set() };
      groups.set(row.name, group);
    }
    group.versions.push(row.version);
    for (const l of parseJsonArray(row.labels)) group.labels.add(l);
  }

  const names = [...groups.keys()];
  const totalItems = names.length;
  const paged = names.slice((page - 1) * limit, (page - 1) * limit + limit);
  const data = paged.map((promptName) => {
    const group = groups.get(promptName)!;
    return toPromptMetaV2Api(group.first, group.versions, [...group.labels]);
  });

  return c.json({
    data,
    meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
  });
});

// ---------------------------------------------------------------------------
// POST /api/public/v2/prompts — create a new version
// ---------------------------------------------------------------------------

app.post("/api/public/v2/prompts", authMiddleware, async (c) => {
  const parsed = CreatePromptSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) return invalidQuery(c, parsed.error.issues);
  const data = parsed.data;
  const projectId = c.get("auth").scope.projectId;
  const name = data.name;
  const type = data.type as "text" | "chat";

  // Same name must keep the same type → 400.
  const existing = await prisma
    .select({ id: prompts.id, type: prompts.type, version: prompts.version })
    .from(prompts)
    .where(and(eq(prompts.projectId, projectId), eq(prompts.name, name)))
    .orderBy(desc(prompts.version))
    .limit(1)
    .then((rows) => rows[0]);
  if (existing && existing.type !== type) {
    throw new InvalidRequestError(
      `Prompt name already exists with type '${existing.type}': '${name}'`,
    );
  }

  // Server-assigned version: max+1 (or 1 for a fresh name).
  const maxVersion = await prisma
    .select({ value: max(prompts.version) })
    .from(prompts)
    .where(and(eq(prompts.projectId, projectId), eq(prompts.name, name)))
    .then((rows) => rows[0]?.value ?? 0);
  const version = maxVersion + 1;

  // Labels: the new version always carries `latest`; provided labels are
  // claimed project-wide (removed from any other version holding them).
  const userLabels = (data.labels ?? []).filter((l) => l !== "latest");
  const claim = [...new Set([...userLabels, "latest"])];
  await releaseLabelsFromOtherVersions(projectId, claim, null);

  let row: PromptRow;
  try {
    const inserted = await prisma
      .insert(prompts)
      .values({
        id: randomUUID(),
        projectId,
        createdBy: c.get("auth").scope.apiKeyId,
        name,
        version,
        type,
        prompt: JSON.stringify({ prompt: data.prompt }),
        config: JSON.stringify(data.config ?? {}),
        tags: JSON.stringify(data.tags ?? []),
        labels: JSON.stringify(claim),
        commitMessage: data.commitMessage ?? null,
      })
      .returning();
    row = inserted[0];
  } catch (error) {
    // Unique-constraint race (projectId+name+version) → 400.
    const known = toKnownRequestError(error);
    if (known?.code === "P2002") {
      throw new InvalidRequestError(`Prompt version ${version} already exists for name '${name}'`);
    }
    throw error;
  }

  // Persist extracted dependencies for later resolution.
  const deps = extractDependencies(data.prompt);
  for (const dep of deps) {
    await prisma.insert(promptDependencies).values({
      id: randomUUID(),
      projectId,
      parentId: row.id,
      childName: dep.childName,
      childLabel: dep.childLabel ?? null,
      childVersion: dep.childVersion ?? null,
    });
  }

  return c.json(toPromptV2Api(row, data.prompt, null), 200);
});

// ---------------------------------------------------------------------------
// GET /api/public/v2/prompts/{promptName} — full Prompt
// ---------------------------------------------------------------------------

app.get("/api/public/v2/prompts/:promptName", authMiddleware, responseCache(2_000), async (c) => {
  const parsed = GetPromptV2Query.safeParse(c.req.query());
  if (!parsed.success) return invalidQuery(c, parsed.error.issues);
  const { version, label, resolve } = parsed.data;
  if (version !== undefined && version !== null && label) {
    throw new InvalidRequestError("Cannot specify both");
  }

  const projectId = c.get("auth").scope.projectId;
  const name = c.req.param("promptName");
  const row = await findPromptVersion(projectId, name, label ?? undefined, version ?? undefined);
  if (!row) {
    // Report the selection that was actually applied: an explicit label /
    // version, or the default "production" label.
    const effectiveLabel =
      label ?? (version === undefined || version === null ? "production" : null);
    throw new LangfuseNotFoundError(
      promptNotFoundMessage(name, { label: effectiveLabel, version: version ?? null }),
    );
  }

  if (!resolve) {
    return c.json(toPromptV2Api(row, parseStoredPrompt(row), null));
  }
  const resolved = await resolvePromptDependencies(projectId, row);
  return c.json(toPromptV2Api(row, resolved.content, resolved.graph));
});

// ---------------------------------------------------------------------------
// PATCH /api/public/v2/prompts/{name}/versions/{version} — replace labels
// ---------------------------------------------------------------------------

app.patch("/api/public/v2/prompts/:name/versions/:version", authMiddleware, async (c) => {
  const parsed = PatchPromptVersionBody.safeParse(await readJsonBody(c));
  if (!parsed.success) return invalidQuery(c, parsed.error.issues);

  const projectId = c.get("auth").scope.projectId;
  const name = c.req.param("name");
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version)) {
    throw new LangfuseNotFoundError(promptNotFoundMessage(name));
  }

  const row = await prisma
    .select()
    .from(prompts)
    .where(
      and(eq(prompts.projectId, projectId), eq(prompts.name, name), eq(prompts.version, version)),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (!row) {
    throw new LangfuseNotFoundError(promptNotFoundMessage(name, { label: null, version }));
  }

  // `latest` is reserved: strip it from the caller's list; if this version is
  // the newest of the name, `latest` is (re)attached by the system.
  const newLabels = [...new Set(parsed.data.newLabels.filter((l) => l !== "latest"))];
  const maxVersion = await prisma
    .select({ value: max(prompts.version) })
    .from(prompts)
    .where(and(eq(prompts.projectId, projectId), eq(prompts.name, name)))
    .then((rows) => rows[0]?.value ?? 0);
  const isLatest = version === maxVersion;
  const finalLabels = isLatest ? [...newLabels, "latest"] : newLabels;

  // Labels are unique across versions: release them project-wide. `latest`
  // is only released when this version IS the newest (it stays put on the
  // newest version otherwise).
  await releaseLabelsFromOtherVersions(
    projectId,
    isLatest ? [...newLabels, "latest"] : newLabels,
    row.id,
  );

  const updated = await prisma
    .update(prompts)
    .set({ labels: JSON.stringify(finalLabels) })
    .where(eq(prompts.id, row.id))
    .returning()
    .then((rows) => rows[0]);

  return c.json(toPromptV2Api(updated, parseStoredPrompt(updated), null), 200);
});

// ---------------------------------------------------------------------------
// DELETE /api/public/v2/prompts/{promptName}
// ---------------------------------------------------------------------------

app.delete("/api/public/v2/prompts/:promptName", authMiddleware, async (c) => {
  const parsed = DeletePromptV2Query.safeParse(c.req.query());
  if (!parsed.success) return invalidQuery(c, parsed.error.issues);
  const { label, version } = parsed.data;
  if (label && version !== undefined && version !== null) {
    throw new InvalidRequestError("Cannot specify both");
  }

  const projectId = c.get("auth").scope.projectId;
  const name = c.req.param("promptName");

  const conditions = [eq(prompts.projectId, projectId), eq(prompts.name, name)];
  if (label) conditions.push(jsonArrayContains(prompts.labels, label));
  if (version !== undefined && version !== null) conditions.push(eq(prompts.version, version));

  const rows = await prisma
    .select({ id: prompts.id })
    .from(prompts)
    .where(and(...conditions));
  if (rows.length === 0) {
    throw new LangfuseNotFoundError(promptNotFoundMessage(name, { label, version }));
  }
  const ids = rows.map((r) => r.id);

  // Clean up dependency rows: this prompt as parent (also cascades via FK)
  // and as a referenced child (childName), which is not covered by the FK.
  await prisma
    .delete(promptDependencies)
    .where(
      and(
        eq(promptDependencies.projectId, projectId),
        or(inArray(promptDependencies.parentId, ids), eq(promptDependencies.childName, name)),
      ),
    );
  await prisma
    .delete(prompts)
    .where(and(eq(prompts.projectId, projectId), inArray(prompts.id, ids)));

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove `labels` from every version except `keepId` (project-wide, since
 * labels are globally unique within a project). No-op when nothing holds them.
 */
async function releaseLabelsFromOtherVersions(
  projectId: string,
  labels: string[],
  keepId: string | null,
): Promise<void> {
  if (labels.length === 0) return;
  const ors = labels.map((l) => jsonArrayContains(prompts.labels, l));
  const holders = await prisma
    .select({ id: prompts.id, labels: prompts.labels })
    .from(prompts)
    .where(and(eq(prompts.projectId, projectId), or(...ors)));

  for (const holder of holders) {
    if (holder.id === keepId) continue;
    const current = parseJsonArray(holder.labels);
    const remaining = current.filter((l) => !labels.includes(l));
    if (remaining.length === current.length) continue;
    await prisma
      .update(prompts)
      .set({ labels: JSON.stringify(remaining) })
      .where(eq(prompts.id, holder.id));
  }
}

/** Re-export for tests/type usage. */
export type { PromptResolutionGraph };

export default app;
