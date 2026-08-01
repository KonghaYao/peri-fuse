import { and, eq, inArray, like, lte, or, type SQL } from "drizzle-orm";
import { type Db, prisma } from "../../db";
import { datasets } from "../../db/schema/index.js";
import type { BatchActionQuery } from "../../features/batchAction/types";
import { escapeSqlLikePattern } from "../utils/sqlLike";

// A folder is strictly a name prefix. A standalone dataset whose name equals the
// folder path is rendered as its own row and must be deleted via its id only —
// matching `name = folderPath` here would silently delete that sibling dataset.
function buildDatasetFolderWhere(folderPath: string): SQL {
  return like(datasets.name, `${escapeSqlLikePattern(folderPath)}/`);
}

export async function findDatasetsForDeletion({
  client = prisma,
  datasetIds,
  folderPaths,
  projectId,
}: {
  client?: Db;
  datasetIds: string[];
  folderPaths: string[];
  projectId: string;
}) {
  if (datasetIds.length === 0 && folderPaths.length === 0) return [];

  return client
    .select()
    .from(datasets)
    .where(
      and(
        eq(datasets.projectId, projectId),
        // OR of explicit ids and folder-prefix matches
        or(inArray(datasets.id, datasetIds), ...folderPaths.map(buildDatasetFolderWhere)),
      ),
    );
}

export async function findDatasetIdsForBatchDeletion({
  cutoffCreatedAt,
  projectId,
  query,
}: {
  cutoffCreatedAt: Date;
  projectId: string;
  query: BatchActionQuery;
}): Promise<Array<{ id: string }>> {
  const conditions: SQL[] = [
    eq(datasets.projectId, projectId),
    lte(datasets.createdAt, cutoffCreatedAt),
  ];

  // Match the listing predicate (resolveSearchCondition) exactly: it ILIKEs the
  // raw query, only trimming to test emptiness. Trimming here too would delete a
  // broader set than the table shows for a whitespace-padded search.
  if (query.searchQuery && query.searchQuery.trim() !== "") {
    conditions.push(like(datasets.name, `%${query.searchQuery}%`));
  }

  if (query.pathPrefix) {
    conditions.push(buildDatasetFolderWhere(query.pathPrefix));
  }

  return prisma
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(...conditions));
}

export async function findDatasetIdsByIds({
  datasetIds,
  projectId,
}: {
  datasetIds: string[];
  projectId: string;
}): Promise<Array<{ id: string }>> {
  if (datasetIds.length === 0) return [];

  return prisma
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.projectId, projectId), inArray(datasets.id, datasetIds)));
}

export async function deleteDatasetsByIds({
  client = prisma,
  datasetIds,
  projectId,
}: {
  client?: Db;
  datasetIds: string[];
  projectId: string;
}) {
  if (datasetIds.length === 0) return;

  await client
    .delete(datasets)
    .where(and(eq(datasets.projectId, projectId), inArray(datasets.id, datasetIds)));
}
