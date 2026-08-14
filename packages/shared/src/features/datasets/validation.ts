import { z } from "zod";
import { DatasetStatus } from "../../db";
import { jsonSchema, StringNoHTMLNonEmpty } from "../../utils/zod";
import { withFolderPathValidation } from "../folders/validation";

/**
 * Dataset name validation schema for API, tRPC and client
 */
export const DatasetNameSchema = withFolderPathValidation(StringNoHTMLNonEmpty);

/**
 * Type for bulk dataset item validation errors
 * Used when validating multiple items before creation (e.g., CSV upload)
 */
export type BulkDatasetItemValidationError = {
  itemIndex: number;
  field: "input" | "expectedOutput" | "metadata";
  errors: Array<{
    path: string;
    message: string;
    keyword?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Public API request schemas (route-internal safeParse + 400, like scores.ts)
// ---------------------------------------------------------------------------

export const DatasetCreateSchema = z.object({
  name: DatasetNameSchema,
  description: z.string().optional(),
  metadata: jsonSchema.optional(),
  inputSchema: jsonSchema.optional(),
  expectedOutputSchema: jsonSchema.optional(),
});

export const DatasetUpdateSchema = DatasetCreateSchema.partial();

export const DatasetItemCreateSchema = z.object({
  id: z.string().optional(),
  input: jsonSchema,
  expectedOutput: jsonSchema.optional(),
  metadata: jsonSchema.optional(),
  sourceTraceId: z.string().optional(),
  sourceObservationId: z.string().optional(),
});

export const DatasetItemUpdateSchema = z.object({
  input: jsonSchema.optional(),
  expectedOutput: jsonSchema.optional(),
  metadata: jsonSchema.optional(),
  status: z.enum(DatasetStatus).optional(),
  sourceTraceId: z.string().optional(),
  sourceObservationId: z.string().optional(),
});

export const DatasetRunCreateSchema = z.object({
  name: DatasetNameSchema,
  description: z.string().optional(),
  metadata: jsonSchema.optional(),
});

/**
 * Create a dataset run item (upstream `CreateDatasetRunItemRequest`, used by
 * POST /api/public/dataset-run-items). The run is located-or-created by
 * `runName`; `traceId` should always be provided but may be inferred from
 * `observationId` for older SDKs.
 */
export const DatasetRunItemCreateSchema = z.object({
  runName: DatasetNameSchema,
  runDescription: z.string().nullish(),
  metadata: jsonSchema.nullish(),
  datasetItemId: z.string().min(1),
  observationId: z.string().nullish(),
  traceId: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// List query schemas (page/limit aligned with users.ts: default 50, max 500)
// ---------------------------------------------------------------------------

const DATASET_LIST_LIMIT_DEFAULT = 50;
const DATASET_LIST_LIMIT_MAX = 500;

const datasetPaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(DATASET_LIST_LIMIT_MAX)
    .default(DATASET_LIST_LIMIT_DEFAULT),
});

export const GetDatasetsQuerySchema = datasetPaginationSchema.extend({
  name: z.string().optional(),
  id: z.string().optional(),
});

export const GetDatasetItemsQuerySchema = datasetPaginationSchema.extend({
  status: z.enum(DatasetStatus).optional(),
});

export const GetDatasetRunsQuerySchema = datasetPaginationSchema;
