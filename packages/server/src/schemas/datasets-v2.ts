/**
 * Zod schemas for the v2 datasets public API (spec components
 * `CreateDatasetRequest` / `PaginatedDatasets`):
 *   POST /api/public/v2/datasets          → CreateDatasetV2Schema
 *   GET  /api/public/v2/datasets          → GetDatasetsV2QuerySchema (page/limit)
 *   GET  /api/public/v2/datasets/{name}   → no query schema
 *
 * The create body mirrors the v1 `DatasetCreateSchema` shape (the shared
 * repository already persists inputSchema/expectedOutputSchema), kept here as
 * an independent schema so v2 validation can diverge from v1 without touching
 * the shared feature module.
 */
import { DatasetNameSchema, jsonSchema } from "@peri-fuse/shared";
import { z } from "zod";

/** POST /api/public/v2/datasets request body (spec `CreateDatasetRequest`). */
export const CreateDatasetV2Schema = z.object({
  name: DatasetNameSchema,
  description: z.string().optional(),
  metadata: jsonSchema.optional(),
  inputSchema: jsonSchema.optional(),
  expectedOutputSchema: jsonSchema.optional(),
});

/**
 * GET /api/public/v2/datasets query params. The spec exposes only
 * page/limit (no name/id filters); defaults aligned with the v1 list
 * endpoints (page 1, limit 50, max 500).
 */
export const GetDatasetsV2QuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(50),
});
