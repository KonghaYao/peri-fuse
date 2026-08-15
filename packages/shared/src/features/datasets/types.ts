/**
 * Public API request/response types for datasets, dataset items and dataset
 * runs (Phase 2 — SDK-compatible datasets endpoints). Pure types: no DB access.
 */

import type { DatasetStatus } from "../../db";
import type { ScoreRecordReadType } from "../../server/repositories/definitions";
import type { JsonNested } from "../../utils/zod";

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export type DatasetCreateBody = {
  name: string;
  description?: string;
  metadata?: JsonNested;
  inputSchema?: JsonNested;
  expectedOutputSchema?: JsonNested;
};

export type DatasetUpdateBody = Partial<DatasetCreateBody>;

export type DatasetItemCreateBody = {
  id?: string;
  input: JsonNested;
  expectedOutput?: JsonNested;
  metadata?: JsonNested;
  sourceTraceId?: string;
  sourceObservationId?: string;
};

export type DatasetItemUpdateBody = {
  input?: JsonNested;
  expectedOutput?: JsonNested;
  metadata?: JsonNested;
  status?: DatasetStatus;
  sourceTraceId?: string;
  sourceObservationId?: string;
};

export type DatasetRunCreateBody = {
  name: string;
  description?: string;
  metadata?: JsonNested;
};

/**
 * Create-dataset-run-item request (upstream `CreateDatasetRunItemRequest`,
 * used by POST /api/public/dataset-run-items). The run is located-or-created
 * by `runName`; `traceId` is required but may be inferred from `observationId`
 * for older SDKs.
 */
export type DatasetRunItemCreateBody = {
  runName: string;
  runDescription?: string | null;
  metadata?: JsonNested | null;
  datasetItemId: string;
  observationId?: string | null;
  traceId?: string | null;
};

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

export type DatasetPublicApi = {
  id: string;
  name: string;
  description: string | null;
  metadata: JsonNested | null;
  projectId: string;
  inputSchema: JsonNested | null;
  expectedOutputSchema: JsonNested | null;
  createdAt: string;
  updatedAt: string;
};

export type DatasetItemPublicApi = {
  id: string;
  projectId: string;
  datasetId: string;
  status: DatasetStatus;
  input: JsonNested | null;
  expectedOutput: JsonNested | null;
  metadata: JsonNested | null;
  sourceTraceId: string | null;
  sourceObservationId: string | null;
  createdAt: string;
  updatedAt: string;
  validFrom: string;
};

/**
 * V1 canonical dataset item shape (GET/POST /api/public/dataset-items,
 * CLI canonical): the upstream `DatasetItem` contract — no projectId/validFrom
 * leak, `datasetName` resolved via join, `mediaReferences` always empty (lite
 * has no media support).
 */
export type DatasetItemV1PublicApi = {
  id: string;
  status: DatasetStatus;
  input: JsonNested | null;
  expectedOutput: JsonNested | null;
  metadata: JsonNested | null;
  sourceTraceId: string | null;
  sourceObservationId: string | null;
  datasetId: string;
  datasetName: string;
  createdAt: string;
  updatedAt: string;
  mediaReferences: [];
};

export type DatasetRunPublicApi = {
  id: string;
  name: string;
  description: string | null;
  metadata: JsonNested | null;
  projectId: string;
  datasetId: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
};

/**
 * Created dataset run item response (mirrors the SDK `DatasetRunItem` shape:
 * id / datasetRunId / datasetRunName / datasetItemId / traceId / observationId
 * / createdAt / updatedAt).
 */
export type DatasetRunItemPublicApi = {
  id: string;
  datasetRunId: string;
  datasetRunName: string;
  datasetItemId: string;
  traceId: string;
  observationId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Dataset run detail item: run item row joined with the dataset item's
 * current-version payload and its associated scores (D3: scores are matched
 * via `scores.trace_id = dataset_run_items.trace_id`).
 */
export type DatasetRunItemWithScores = {
  id: string;
  projectId: string;
  datasetRunId: string;
  datasetItemId: string;
  datasetId: string;
  traceId: string;
  observationId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  // dataset run fields
  datasetRunName: string;
  datasetRunDescription: string | null;
  datasetRunMetadata: JsonNested | null;
  datasetRunCreatedAt: string;
  // dataset item fields (current version)
  datasetItemInput: JsonNested | null;
  datasetItemExpectedOutput: JsonNested | null;
  datasetItemMetadata: JsonNested | null;
  datasetItemVersion: string | null;
  // associated scores (by trace id)
  scores: ScoreRecordReadType[];
};
