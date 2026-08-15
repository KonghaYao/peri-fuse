/**
 * Query/body schemas for the v1 canonical dataset-items endpoints
 * (GET/POST /api/public/dataset-items, GET/DELETE /api/public/dataset-items/{id}).
 *
 * Field sets follow the upstream v4.10.0 spec (`DatasetItem`,
 * `CreateDatasetItemRequest`): POST requires only `datasetName`; `input`,
 * `expectedOutput` and `metadata` are nullable JSON. `status` is accepted but
 * only ACTIVE is supported by the lite writer (the spec default).
 */
import { jsonSchema, publicApiPaginationZod } from "@peri-fuse/shared";
import { stringDateTime } from "@peri-fuse/shared/src/server";
import { z } from "zod";

// GET /api/public/dataset-items
export const GetDatasetItemsV1Query = z.object({
  ...publicApiPaginationZod,
  datasetName: z.string().nullish(),
  sourceTraceId: z.string().nullish(),
  sourceObservationId: z.string().nullish(),
  // ISO 8601 (RFC 3339) UTC timestamp; requires datasetName to be specified.
  version: stringDateTime,
});

// POST /api/public/dataset-items
export const CreateDatasetItemV1Body = z.object({
  datasetName: z.string().min(1),
  input: jsonSchema.nullish(),
  expectedOutput: jsonSchema.nullish(),
  metadata: jsonSchema.nullish(),
  sourceTraceId: z.string().nullish(),
  sourceObservationId: z.string().nullish(),
  // Upsert key; unique per project, at most 255 chars.
  id: z.string().max(255).nullish(),
  // Spec default is ACTIVE; ARCHIVED is not supported by the lite writer.
  status: z.literal("ACTIVE").nullish(),
});
