/**
 * Dataset runs metadata (metadata DB via Drizzle) + run item lookup
 * (telemetry DB via raw SQL — `dataset_run_items` lives there, decision D2).
 *
 * Cross-database assembly (D3): run detail scores come from
 * `scores.trace_id = dataset_run_items.trace_id` (the scores table has no
 * `dataset_run_id` column). Queries against `dataset_run_items` are fault
 * tolerant: the table is created by the telemetry adapter at boot; when it is
 * absent (older DB, adapter not yet upgraded) we return an empty item list.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { type DatasetItem, type DatasetRuns, prisma, toKnownRequestError } from "../../db";
import { datasetItems, datasetRuns } from "../../db/schema/index.js";
import { LangfuseConflictError, LangfuseNotFoundError } from "../../errors";
import type { TelemetryDBAdapter } from "../../server/adapters/types";
import type { ScoreRecordReadType } from "../../server/repositories/definitions";
import { getDatasetById, stringifyJson } from "./datasets";
import type { DatasetRunCreateBody } from "./types";

/** Raw row shape of the telemetry `dataset_run_items` table. */
export type DatasetRunItemRow = {
  id: string;
  project_id: string;
  dataset_run_id: string;
  dataset_item_id: string;
  dataset_id: string;
  trace_id: string;
  observation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: number;
};

// ---------------------------------------------------------------------------
// Runs (metadata DB)
// ---------------------------------------------------------------------------

export async function createDatasetRun(
  projectId: string,
  datasetId: string,
  body: DatasetRunCreateBody,
): Promise<DatasetRuns> {
  await getDatasetById(projectId, datasetId);

  const existing = await prisma
    .select({ id: datasetRuns.id })
    .from(datasetRuns)
    .where(
      and(
        eq(datasetRuns.datasetId, datasetId),
        eq(datasetRuns.projectId, projectId),
        eq(datasetRuns.name, body.name),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (existing) {
    throw new LangfuseConflictError(`Dataset run with name '${body.name}' already exists`);
  }

  try {
    const rows = await prisma
      .insert(datasetRuns)
      .values({
        id: randomUUID(),
        projectId,
        datasetId,
        name: body.name,
        description: body.description ?? null,
        metadata: stringifyJson(body.metadata),
      })
      .returning();
    return rows[0];
  } catch (error) {
    const known = toKnownRequestError(error);
    if (known?.code === "P2002") {
      throw new LangfuseConflictError(`Dataset run with name '${body.name}' already exists`);
    }
    throw error;
  }
}

export async function getDatasetRunById(
  projectId: string,
  datasetId: string,
  runId: string,
): Promise<DatasetRuns> {
  const row = await prisma.query.datasetRuns.findFirst({
    where: and(
      eq(datasetRuns.id, runId),
      eq(datasetRuns.projectId, projectId),
      eq(datasetRuns.datasetId, datasetId),
    ),
  });
  if (!row) {
    throw new LangfuseNotFoundError(`Dataset run with id '${runId}' not found`);
  }
  return row;
}

export async function listDatasetRuns(
  projectId: string,
  datasetId: string,
  opts: { page: number; limit: number },
): Promise<{ items: DatasetRuns[]; totalItems: number }> {
  const where = and(eq(datasetRuns.datasetId, datasetId), eq(datasetRuns.projectId, projectId));

  const items = await prisma.query.datasetRuns.findMany({
    where,
    orderBy: desc(datasetRuns.createdAt),
    limit: opts.limit,
    offset: (opts.page - 1) * opts.limit,
  });

  const totalItems =
    (await prisma
      .select({ value: count() })
      .from(datasetRuns)
      .where(where)
      .then((rows) => rows[0]?.value ?? 0)) ?? 0;

  return { items, totalItems };
}

/**
 * Current-version item counts per dataset id (used for the run list shape).
 */
export async function countDatasetItemsByDataset(
  projectId: string,
  datasetIds: string[],
): Promise<Map<string, number>> {
  if (datasetIds.length === 0) return new Map();
  const rows = await prisma
    .select({ datasetId: datasetItems.datasetId, value: count() })
    .from(datasetItems)
    .where(
      and(
        eq(datasetItems.projectId, projectId),
        inArray(datasetItems.datasetId, datasetIds),
        isNull(datasetItems.validTo),
        eq(datasetItems.isDeleted, false),
      ),
    )
    .groupBy(datasetItems.datasetId);
  return new Map(rows.map((row) => [row.datasetId, row.value]));
}

// ---------------------------------------------------------------------------
// Run items (telemetry DB, fault-tolerant)
// ---------------------------------------------------------------------------

export async function getDatasetRunItems(
  projectId: string,
  runId: string,
): Promise<DatasetRunItemRow[]> {
  const [{ getTelemetryDB }, { logger }] = await Promise.all([
    import("../../server/adapters/index.js"),
    import("../../server/logger.js"),
  ]);
  const db: TelemetryDBAdapter = getTelemetryDB();
  try {
    const rows = await db.query<Record<string, unknown>>({
      query: `
        SELECT * FROM dataset_run_items
        WHERE project_id = @projectId AND dataset_run_id = @runId AND is_deleted = 0
        ORDER BY created_at ASC
      `,
      params: { projectId, runId },
    });
    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      dataset_run_id: String(row.dataset_run_id),
      dataset_item_id: String(row.dataset_item_id),
      dataset_id: String(row.dataset_id),
      trace_id: String(row.trace_id),
      observation_id: row.observation_id ? String(row.observation_id) : null,
      error: row.error ? String(row.error) : null,
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
      is_deleted: Number(row.is_deleted ?? 0),
    }));
  } catch (error) {
    // The table may not exist yet on databases booted before the telemetry
    // schema gained dataset_run_items; treat that as "no run items".
    logger.warn(`[getDatasetRunItems] Query failed for run ${runId}`, error);
    return [];
  }
}

/** Scores for the run's traces (joined by trace_id, decision D3). */
export async function getRunItemScores(
  projectId: string,
  traceIds: string[],
): Promise<Map<string, ScoreRecordReadType[]>> {
  const { liteGetScoresForTraces } = await import("../../server/repositories/lite-queries.js");
  const scores = await liteGetScoresForTraces(projectId, traceIds);
  const byTrace = new Map<string, ScoreRecordReadType[]>();
  for (const score of scores) {
    if (!score.trace_id) continue;
    const list = byTrace.get(score.trace_id) ?? [];
    list.push(score);
    byTrace.set(score.trace_id, list);
  }
  return byTrace;
}

/**
 * Current-version dataset items by item id (batch lookup, no IO parse).
 */
export async function getDatasetItemsCurrentVersions(
  projectId: string,
  itemIds: string[],
): Promise<Map<string, DatasetItem>> {
  if (itemIds.length === 0) return new Map();
  const rows = await prisma.query.datasetItems.findMany({
    where: and(
      eq(datasetItems.projectId, projectId),
      inArray(datasetItems.id, itemIds),
      isNull(datasetItems.validTo),
      eq(datasetItems.isDeleted, false),
    ),
  });
  return new Map(rows.map((row) => [row.id, row]));
}
