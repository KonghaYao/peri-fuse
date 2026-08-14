/**
 * Dataset item versioned writes (metadata DB via Drizzle).
 *
 * Versioning semantics (decision D1): POST/PATCH close the current version
 * (`UPDATE valid_to = now` on the row with `valid_to IS NULL`) and insert a
 * new row with `valid_from = now`; reads only return the current version
 * (`valid_to IS NULL AND is_deleted = 0`). DELETE is a soft delete. Items with
 * no current version (deleted/archived) are 404 for PATCH/DELETE (decision R2).
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { type DatasetItem, type DatasetStatus, prisma } from "../../db";
import { datasetItems, datasets } from "../../db/schema/index.js";
import { LangfuseNotFoundError } from "../../errors";
import { stringifyJson } from "./datasets";
import type { DatasetItemCreateBody, DatasetItemUpdateBody } from "./types";

// ---------------------------------------------------------------------------
// Current-version lookup
// ---------------------------------------------------------------------------

export async function getDatasetItemCurrentVersion(
  projectId: string,
  datasetId: string,
  itemId: string,
): Promise<DatasetItem | null> {
  const row = await prisma.query.datasetItems.findFirst({
    where: and(
      eq(datasetItems.id, itemId),
      eq(datasetItems.projectId, projectId),
      eq(datasetItems.datasetId, datasetId),
      isNull(datasetItems.validTo),
      eq(datasetItems.isDeleted, false),
    ),
  });
  return row ?? null;
}

async function requireDatasetItemCurrentVersion(
  projectId: string,
  datasetId: string,
  itemId: string,
): Promise<DatasetItem> {
  const row = await getDatasetItemCurrentVersion(projectId, datasetId, itemId);
  if (!row) {
    throw new LangfuseNotFoundError(
      `Dataset item with id '${itemId}' not found or has no active version`,
    );
  }
  return row;
}

/**
 * Look up the current version of a dataset item by id alone (across datasets
 * within the project). Used by dataset run item creation, which references
 * items by id without a dataset scope. Returns the row including datasetId.
 */
export async function getDatasetItemById(
  projectId: string,
  itemId: string,
): Promise<DatasetItem | null> {
  const row = await prisma.query.datasetItems.findFirst({
    where: and(
      eq(datasetItems.id, itemId),
      eq(datasetItems.projectId, projectId),
      isNull(datasetItems.validTo),
      eq(datasetItems.isDeleted, false),
    ),
  });
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function closeCurrentVersion(row: DatasetItem, now: Date): void {
  // better-sqlite3 is a single synchronous connection, so the
  // close-then-insert pair is atomic without an explicit transaction.
  prisma
    .update(datasetItems)
    .set({ validTo: now, updatedAt: now })
    .where(
      and(
        eq(datasetItems.id, row.id),
        eq(datasetItems.projectId, row.projectId),
        eq(datasetItems.validFrom, row.validFrom),
      ),
    )
    .run();
}

function insertItemVersion(
  projectId: string,
  datasetId: string,
  itemId: string,
  fields: {
    input: string | null;
    expectedOutput: string | null;
    metadata: string | null;
    sourceTraceId: string | null;
    sourceObservationId: string | null;
    status: DatasetStatus;
  },
  now: Date,
): Promise<DatasetItem> {
  return prisma
    .insert(datasetItems)
    .values({
      id: itemId,
      projectId,
      datasetId,
      status: fields.status,
      input: fields.input,
      expectedOutput: fields.expectedOutput,
      metadata: fields.metadata,
      sourceTraceId: fields.sourceTraceId,
      sourceObservationId: fields.sourceObservationId,
      validFrom: now,
      validTo: null,
      isDeleted: false,
    })
    .returning()
    .then((rows) => rows[0]);
}

/**
 * Create (or re-create) dataset items. Re-using an existing item id closes the
 * current version and inserts a new one (versioning, D1). Returns the current
 * version row for each item, in request order. 404 when the dataset is missing.
 */
export async function createDatasetItems(
  projectId: string,
  datasetId: string,
  items: DatasetItemCreateBody[],
): Promise<DatasetItem[]> {
  const dataset = await prisma.query.datasets.findFirst({
    where: and(eq(datasets.id, datasetId), eq(datasets.projectId, projectId)),
  });
  if (!dataset) {
    throw new LangfuseNotFoundError(`Dataset with id '${datasetId}' not found`);
  }

  const created: DatasetItem[] = [];
  for (const item of items) {
    const now = new Date();
    const itemId = item.id ?? randomUUID();
    const current = await getDatasetItemCurrentVersion(projectId, datasetId, itemId);
    if (current) {
      closeCurrentVersion(current, now);
    }
    created.push(
      await insertItemVersion(
        projectId,
        datasetId,
        itemId,
        {
          input: stringifyJson(item.input),
          expectedOutput: stringifyJson(item.expectedOutput),
          metadata: stringifyJson(item.metadata),
          sourceTraceId: item.sourceTraceId ?? null,
          sourceObservationId: item.sourceObservationId ?? null,
          status: "ACTIVE",
        },
        now,
      ),
    );
  }
  return created;
}

export async function listDatasetItems(
  projectId: string,
  datasetId: string,
  opts: { page: number; limit: number; status?: DatasetStatus },
): Promise<{ items: DatasetItem[]; totalItems: number }> {
  const where = and(
    eq(datasetItems.datasetId, datasetId),
    eq(datasetItems.projectId, projectId),
    isNull(datasetItems.validTo),
    eq(datasetItems.isDeleted, false),
    opts.status !== undefined ? eq(datasetItems.status, opts.status) : undefined,
  );

  const items = await prisma.query.datasetItems.findMany({
    where,
    orderBy: desc(datasetItems.createdAt),
    limit: opts.limit,
    offset: (opts.page - 1) * opts.limit,
  });

  const totalItems =
    (await prisma
      .select({ value: count() })
      .from(datasetItems)
      .where(where)
      .then((rows) => rows[0]?.value ?? 0)) ?? 0;

  return { items, totalItems };
}

/**
 * Update the current version of an item by closing it and inserting a new
 * version carrying the merged fields. 404 when there is no current version.
 */
export async function updateDatasetItem(
  projectId: string,
  datasetId: string,
  itemId: string,
  body: DatasetItemUpdateBody,
): Promise<DatasetItem> {
  const current = await requireDatasetItemCurrentVersion(projectId, datasetId, itemId);
  const now = new Date();

  closeCurrentVersion(current, now);
  return insertItemVersion(
    projectId,
    datasetId,
    itemId,
    {
      input: body.input !== undefined ? stringifyJson(body.input) : (current.input ?? null),
      expectedOutput:
        body.expectedOutput !== undefined
          ? stringifyJson(body.expectedOutput)
          : (current.expectedOutput ?? null),
      metadata:
        body.metadata !== undefined ? stringifyJson(body.metadata) : (current.metadata ?? null),
      sourceTraceId: body.sourceTraceId ?? current.sourceTraceId ?? null,
      sourceObservationId: body.sourceObservationId ?? current.sourceObservationId ?? null,
      status: (body.status ?? current.status ?? "ACTIVE") as DatasetStatus,
    },
    now,
  );
}

/** Soft delete the current version (marks it deleted and closes it). */
export async function deleteDatasetItem(
  projectId: string,
  datasetId: string,
  itemId: string,
): Promise<void> {
  const current = await requireDatasetItemCurrentVersion(projectId, datasetId, itemId);
  prisma
    .update(datasetItems)
    .set({ isDeleted: true, validTo: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(datasetItems.id, current.id),
        eq(datasetItems.projectId, current.projectId),
        eq(datasetItems.validFrom, current.validFrom),
      ),
    )
    .run();
}
