/**
 * Prompt v2 shaping + dependency resolution.
 *
 * Storage format (decision §3.7): the DB `prompt` column stores
 * `JSON.stringify({ prompt })`; config/labels/tags are JSON-encoded strings.
 * The response `isActive` field is DERIVED (labels contain "production") and
 * never participates in version selection. `resolve` (default true) resolves
 * prompt dependencies (`{{prompt:name@label}}` / `{{prompt:name#version}}`)
 * and returns the `resolutionGraph`; with `resolve=false` the raw stored
 * prompt is returned with dependency tags intact and graph = null.
 */

import { LangfuseNotFoundError, parseJsonField } from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { promptDependencies, prompts } from "@peri-fuse/shared/src/db/schema/index.js";
import { escapeSqlLikePattern } from "@peri-fuse/shared/src/server";
import { and, desc, eq, like } from "drizzle-orm";

export type PromptRow = typeof prompts.$inferSelect;

/** spec BasePrompt.resolutionGraph: { [name]: { version, labels, dependencies } }. */
export type PromptResolutionGraph = {
  [name: string]: {
    version: number;
    labels: string[];
    dependencies: PromptResolutionGraph;
  };
};

// ---------------------------------------------------------------------------
// Storage format helpers
// ---------------------------------------------------------------------------

export function parseJsonArray(value: string | null | undefined): string[] {
  const parsed = parseJsonField(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/** Unwrap the stored `{"prompt": …}` envelope (defensive: raw string fallback). */
export function parseStoredPrompt(row: Pick<PromptRow, "prompt">): unknown {
  const parsed = parseJsonField(row.prompt);
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "prompt" in parsed
  ) {
    return (parsed as { prompt: unknown }).prompt;
  }
  return row.prompt;
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

export interface PromptV2Api {
  name: string;
  version: number;
  config: unknown;
  labels: string[];
  tags: string[];
  commitMessage: string | null;
  resolutionGraph: PromptResolutionGraph | null;
  type: "text" | "chat";
  prompt: unknown;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPromptV2Api(
  row: PromptRow,
  promptContent: unknown,
  resolutionGraph: PromptResolutionGraph | null,
): PromptV2Api {
  const labels = parseJsonArray(row.labels);
  return {
    name: row.name,
    version: row.version,
    config: parseJsonField(row.config) ?? {},
    labels,
    tags: parseJsonArray(row.tags),
    commitMessage: row.commitMessage,
    resolutionGraph,
    type: row.type === "chat" ? "chat" : "text",
    prompt: promptContent,
    // Derived field — labels contain "production" (spec semantics).
    isActive: labels.includes("production"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface PromptMetaV2Api {
  name: string;
  type: "text" | "chat";
  versions: number[];
  labels: string[];
  tags: string[];
  lastUpdatedAt: string;
  lastConfig: unknown;
}

/**
 * Name-level aggregation for PromptMetaListResponse. `firstRow` must be the
 * most recent matching version (callers order by updatedAt DESC); its config
 * becomes lastConfig per the spec ("most recent prompt version that matches
 * the filters").
 */
export function toPromptMetaV2Api(
  firstRow: PromptRow,
  versions: number[],
  labels: string[],
): PromptMetaV2Api {
  return {
    name: firstRow.name,
    type: firstRow.type === "chat" ? "chat" : "text",
    versions,
    labels,
    tags: parseJsonArray(firstRow.tags),
    lastUpdatedAt: firstRow.updatedAt.toISOString(),
    lastConfig: parseJsonField(firstRow.config) ?? {},
  };
}

/** 404 message aligned with upstream, e.g. `Prompt not found: 'x' with label 'production'`. */
export function promptNotFoundMessage(
  name: string,
  select?: { label?: string | null; version?: number | null },
): string {
  if (select?.label) return `Prompt not found: '${name}' with label '${select.label}'`;
  if (select?.version !== undefined && select?.version !== null) {
    return `Prompt not found: '${name}' with version '${select.version}'`;
  }
  return `Prompt not found: '${name}'`;
}

// ---------------------------------------------------------------------------
// Dependency extraction & resolution
// ---------------------------------------------------------------------------

const DEPENDENCY_RE =
  /\{\{\s*prompt\s*:\s*([^@#{}]+?)\s*(?:@\s*([^#{}]+?))?\s*(?:#\s*(\d+))?\s*\}\}/g;

export interface ExtractedDependency {
  childName: string;
  childLabel?: string;
  childVersion?: number;
}

const depKey = (name: string, label?: string, version?: number) =>
  `${name}|${label ?? ""}|${version ?? ""}`;

function scanDependencies(text: string): ExtractedDependency[] {
  const found: ExtractedDependency[] = [];
  const seen = new Set<string>();
  DEPENDENCY_RE.lastIndex = 0;
  for (let match = DEPENDENCY_RE.exec(text); match; match = DEPENDENCY_RE.exec(text)) {
    const key = depKey(match[1], match[2], match[3] ? Number(match[3]) : undefined);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      childName: match[1].trim(),
      childLabel: match[2]?.trim() || undefined,
      childVersion: match[3] ? Number(match[3]) : undefined,
    });
  }
  return found;
}

/**
 * Extract dependency tags from prompt content: a text prompt is scanned
 * directly, a chat prompt through every message's string `content`.
 */
export function extractDependencies(content: unknown): ExtractedDependency[] {
  if (typeof content === "string") return scanDependencies(content);
  if (Array.isArray(content)) {
    const all: ExtractedDependency[] = [];
    for (const message of content) {
      if (
        message &&
        typeof message === "object" &&
        typeof (message as { content?: unknown }).content === "string"
      ) {
        all.push(...scanDependencies((message as { content: string }).content));
      }
    }
    return all;
  }
  return [];
}

/**
 * Read a prompt's dependencies from prompt_dependencies; falls back to
 * re-extracting from the stored content (e.g. rows written before the
 * dependency table was populated).
 */
async function loadDependencies(projectId: string, row: PromptRow): Promise<ExtractedDependency[]> {
  const rows = await prisma
    .select()
    .from(promptDependencies)
    .where(
      and(eq(promptDependencies.projectId, projectId), eq(promptDependencies.parentId, row.id)),
    );
  if (rows.length > 0) {
    return rows.map((r: typeof promptDependencies.$inferSelect) => ({
      childName: r.childName,
      childLabel: r.childLabel ?? undefined,
      childVersion: r.childVersion ?? undefined,
    }));
  }
  return extractDependencies(parseStoredPrompt(row));
}

/**
 * Version selection for a dependency reference: explicit label wins, then
 * explicit version, then the default "production" label.
 */
export async function findPromptVersion(
  projectId: string,
  name: string,
  label?: string,
  version?: number,
): Promise<PromptRow | undefined> {
  const conditions = [eq(prompts.projectId, projectId), eq(prompts.name, name)];
  if (label) {
    conditions.push(like(prompts.labels, `%"${escapeSqlLikePattern(label)}"%`));
  } else if (version !== undefined && version !== null) {
    conditions.push(eq(prompts.version, version));
  } else {
    conditions.push(like(prompts.labels, `%"production"%`));
  }
  return prisma
    .select()
    .from(prompts)
    .where(and(...conditions))
    .orderBy(desc(prompts.version))
    .limit(1)
    .then((rows) => rows[0]);
}

function replaceInText(text: string, resolved: Map<string, unknown>): string {
  return text.replace(DEPENDENCY_RE, (match, name: string, label?: string, version?: string) => {
    const value = resolved.get(depKey(name, label, version ? Number(version) : undefined));
    if (value === undefined) return match;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

function replacePlaceholders(content: unknown, resolved: Map<string, unknown>): unknown {
  if (typeof content === "string") return replaceInText(content, resolved);
  if (Array.isArray(content)) {
    return content.map((message) => {
      if (
        message &&
        typeof message === "object" &&
        typeof (message as { content?: unknown }).content === "string"
      ) {
        return {
          ...(message as Record<string, unknown>),
          content: replaceInText((message as { content: string }).content, resolved),
        };
      }
      return message;
    });
  }
  return content;
}

/**
 * Recursively resolve dependencies into `graph` and return the replacement
 * values keyed by (name,label,version). Cycles are broken by a visiting set —
 * the cyclic tag is left intact and omitted from the graph.
 */
async function resolveDependencyMap(
  projectId: string,
  deps: ExtractedDependency[],
  visiting: Set<string>,
  graph: PromptResolutionGraph,
): Promise<Map<string, unknown>> {
  const resolved = new Map<string, unknown>();
  for (const dep of deps) {
    const key = depKey(dep.childName, dep.childLabel, dep.childVersion);
    if (resolved.has(key) || visiting.has(key)) continue;
    visiting.add(key);

    const child = await findPromptVersion(
      projectId,
      dep.childName,
      dep.childLabel,
      dep.childVersion,
    );
    if (!child) {
      throw new LangfuseNotFoundError(
        promptNotFoundMessage(dep.childName, {
          label: dep.childLabel ?? null,
          version: dep.childVersion ?? null,
        }),
      );
    }

    const childContent = parseStoredPrompt(child);
    const subGraph: PromptResolutionGraph = {};
    const childMap = await resolveDependencyMap(
      projectId,
      await loadDependencies(projectId, child),
      visiting,
      subGraph,
    );
    const resolvedChildContent = replacePlaceholders(childContent, childMap);

    graph[dep.childName] = {
      version: child.version,
      labels: parseJsonArray(child.labels),
      dependencies: subGraph,
    };
    resolved.set(key, resolvedChildContent);
    visiting.delete(key);
  }
  return resolved;
}

export interface ResolvedPrompt {
  content: unknown;
  graph: PromptResolutionGraph | null;
}

/**
 * Resolve the prompt's dependencies (default `resolve=true` behavior).
 * Returns null graph when the prompt has no dependencies.
 */
export async function resolvePromptDependencies(
  projectId: string,
  row: PromptRow,
): Promise<ResolvedPrompt> {
  const content = parseStoredPrompt(row);
  const deps = await loadDependencies(projectId, row);
  if (deps.length === 0) return { content, graph: null };

  const graph: PromptResolutionGraph = {};
  const resolved = await resolveDependencyMap(projectId, deps, new Set(), graph);
  return { content: replacePlaceholders(content, resolved), graph };
}
