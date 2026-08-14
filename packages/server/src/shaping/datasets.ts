/**
 * Dataset API shaping: row → public API object conversion plus run-detail
 * assembly (cross-DB: runs/items in the metadata DB, run items/scores in the
 * telemetry DB — decision D2/D3).
 */

import {
  type DatasetItemPublicApi,
  type DatasetPublicApi,
  type DatasetRunItemRow,
  type DatasetRunItemWithScores,
  type DatasetRunPublicApi,
  parseJsonField,
} from "@peri-fuse/shared";
import type { Dataset, DatasetItem, DatasetRuns } from "@peri-fuse/shared/src/db";
import type { ScoreRecordReadType } from "@peri-fuse/shared/src/server";

export function toDatasetPublicApi(row: Dataset): DatasetPublicApi {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metadata: parseJsonField(row.metadata),
    projectId: row.projectId,
    inputSchema: parseJsonField(row.inputSchema),
    expectedOutputSchema: parseJsonField(row.expectedOutputSchema),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDatasetItemPublicApi(row: DatasetItem): DatasetItemPublicApi {
  return {
    id: row.id,
    projectId: row.projectId,
    datasetId: row.datasetId,
    status: (row.status ?? "ACTIVE") as DatasetItemPublicApi["status"],
    input: parseJsonField(row.input),
    expectedOutput: parseJsonField(row.expectedOutput),
    metadata: parseJsonField(row.metadata),
    sourceTraceId: row.sourceTraceId,
    sourceObservationId: row.sourceObservationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    validFrom: row.validFrom.toISOString(),
  };
}

export function toDatasetRunPublicApi(row: DatasetRuns, itemCount: number): DatasetRunPublicApi {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metadata: parseJsonField(row.metadata),
    projectId: row.projectId,
    datasetId: row.datasetId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    itemCount,
  };
}

/**
 * Assemble the run-detail item list: each run item is joined with the
 * dataset item's current-version payload (input/expectedOutput/metadata +
 * validFrom as datasetItemVersion) and the scores of its trace (D3).
 */
export function assembleRunDetail(
  run: DatasetRuns,
  runItems: DatasetRunItemRow[],
  scoresByTrace: Map<string, ScoreRecordReadType[]>,
  itemVersions: Map<string, DatasetItem>,
): DatasetRunItemWithScores[] {
  return runItems.map((item) => {
    const version = itemVersions.get(item.dataset_item_id);
    return {
      id: item.id,
      projectId: item.project_id,
      datasetRunId: item.dataset_run_id,
      datasetItemId: item.dataset_item_id,
      datasetId: item.dataset_id,
      traceId: item.trace_id,
      observationId: item.observation_id,
      error: item.error,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      // dataset run fields
      datasetRunName: run.name,
      datasetRunDescription: run.description,
      datasetRunMetadata: parseJsonField(run.metadata),
      datasetRunCreatedAt: run.createdAt.toISOString(),
      // dataset item fields (current version)
      datasetItemInput: parseJsonField(version?.input),
      datasetItemExpectedOutput: parseJsonField(version?.expectedOutput),
      datasetItemMetadata: parseJsonField(version?.metadata),
      datasetItemVersion: version ? version.validFrom.toISOString() : null,
      // associated scores (by trace id)
      scores: scoresByTrace.get(item.trace_id) ?? [],
    };
  });
}
