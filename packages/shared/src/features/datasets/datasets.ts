/**
 * Dataset metadata CRUD (metadata DB via Drizzle).
 *
 * Project isolation: every query/write filters by `projectId`. Name conflicts
 * surface as 409 (LangfuseConflictError); missing rows as 404
 * (LangfuseNotFoundError) — mapped to HTTP codes by the app-level onError.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, ne } from "drizzle-orm";
import { type Dataset, prisma, toKnownRequestError } from "../../db";
import { datasets } from "../../db/schema/index.js";
import { LangfuseConflictError, LangfuseNotFoundError } from "../../errors";
import { parseJsonPrioritised } from "../../utils/json";
import type { JsonNested } from "../../utils/zod";
import type { DatasetCreateBody, DatasetUpdateBody } from "./types";

// ---------------------------------------------------------------------------
// JSON helpers (stringify-on-write / parse-on-read)
// ---------------------------------------------------------------------------

export function stringifyJson(value: JsonNested | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function parseJsonField(value: string | null | undefined): JsonNested | null {
  if (!value) return null;
  const parsed = parseJsonPrioritised(value);
  // Malformed JSON falls back to the raw string upstream; lite writes only
  // valid JSON, so treat an unparseable value as absent.
  return typeof parsed === "string" ? null : (parsed ?? null);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDatasetById(projectId: string, datasetId: string): Promise<Dataset> {
  const row = await prisma.query.datasets.findFirst({
    where: and(eq(datasets.id, datasetId), eq(datasets.projectId, projectId)),
  });
  if (!row) {
    throw new LangfuseNotFoundError(`Dataset with id '${datasetId}' not found`);
  }
  return row;
}

export async function listDatasets(
  projectId: string,
  opts: { page: number; limit: number; name?: string; id?: string },
): Promise<{ items: Dataset[]; totalItems: number }> {
  const where = and(
    eq(datasets.projectId, projectId),
    opts.name !== undefined ? eq(datasets.name, opts.name) : undefined,
    opts.id !== undefined ? eq(datasets.id, opts.id) : undefined,
  );

  const items = await prisma.query.datasets.findMany({
    where,
    orderBy: desc(datasets.createdAt),
    limit: opts.limit,
    offset: (opts.page - 1) * opts.limit,
  });

  const totalItems =
    (await prisma
      .select({ value: count() })
      .from(datasets)
      .where(where)
      .then((rows) => rows[0]?.value ?? 0)) ?? 0;

  return { items, totalItems };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function conflict(message: string): never {
  throw new LangfuseConflictError(message);
}

export async function createDataset(projectId: string, body: DatasetCreateBody): Promise<Dataset> {
  const existing = await prisma
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.projectId, projectId), eq(datasets.name, body.name)))
    .limit(1)
    .then((rows) => rows[0]);
  if (existing) {
    conflict(`Dataset with name '${body.name}' already exists`);
  }

  try {
    const rows = await prisma
      .insert(datasets)
      .values({
        id: randomUUID(),
        projectId,
        name: body.name,
        description: body.description ?? null,
        metadata: stringifyJson(body.metadata),
        inputSchema: stringifyJson(body.inputSchema),
        expectedOutputSchema: stringifyJson(body.expectedOutputSchema),
      })
      .returning();
    return rows[0];
  } catch (error) {
    const known = toKnownRequestError(error);
    if (known?.code === "P2002") {
      conflict(`Dataset with name '${body.name}' already exists`);
    }
    throw error;
  }
}

export async function updateDataset(
  projectId: string,
  datasetId: string,
  body: DatasetUpdateBody,
): Promise<Dataset> {
  const current = await getDatasetById(projectId, datasetId);

  if (body.name !== undefined && body.name !== current.name) {
    const clash = await prisma
      .select({ id: datasets.id })
      .from(datasets)
      .where(
        and(
          eq(datasets.projectId, projectId),
          eq(datasets.name, body.name),
          ne(datasets.id, datasetId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (clash) {
      conflict(`Dataset with name '${body.name}' already exists`);
    }
  }

  const values: Partial<typeof datasets.$inferInsert> = {};
  if (body.name !== undefined) values.name = body.name;
  if (body.description !== undefined) values.description = body.description;
  if (body.metadata !== undefined) values.metadata = stringifyJson(body.metadata);
  if (body.inputSchema !== undefined) values.inputSchema = stringifyJson(body.inputSchema);
  if (body.expectedOutputSchema !== undefined) {
    values.expectedOutputSchema = stringifyJson(body.expectedOutputSchema);
  }

  if (Object.keys(values).length === 0) return current;

  try {
    const rows = await prisma
      .update(datasets)
      .set(values)
      .where(and(eq(datasets.id, datasetId), eq(datasets.projectId, projectId)))
      .returning();
    return rows[0];
  } catch (error) {
    const known = toKnownRequestError(error);
    if (known?.code === "P2002") {
      conflict(`Dataset with name '${body.name}' already exists`);
    }
    throw error;
  }
}

export async function deleteDataset(projectId: string, datasetId: string): Promise<void> {
  await getDatasetById(projectId, datasetId);
  // Items and runs are removed by the FK cascade
  // (dataset_items/dataset_runs → datasets, onDelete: cascade).
  await prisma
    .delete(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.projectId, projectId)));
}
