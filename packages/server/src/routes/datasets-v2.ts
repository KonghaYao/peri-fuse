/**
 * v2 datasets public API routes (spec operations `datasets_list` /
 * `datasets_create` / `datasets_get`).
 *
 * GET  /api/public/v2/datasets         → PaginatedDatasets (page/limit)
 * POST /api/public/v2/datasets         → Dataset (CreateDatasetRequest body)
 * GET  /api/public/v2/datasets/{name}  → Dataset (lookup by name)
 *
 * Reuses the v1 dataset repository (createDataset/listDatasets) and shaping
 * (toDatasetPublicApi): the v2 `Dataset` response shape is identical to the
 * v1 public shape (id/name/description/metadata/inputSchema/
 * expectedOutputSchema/projectId/createdAt/updatedAt), and the v1 POST
 * already persists inputSchema/expectedOutputSchema. The by-name lookup is
 * implemented here with a direct project-scoped query (the shared repository
 * only exposes by-id lookups).
 *
 * Errors use BaseError subclasses mapped by the app-level onError
 * (404 LangfuseNotFoundError, 409 LangfuseConflictError, 400
 * InvalidRequestData handled inline). Reads are project-scoped and cacheable
 * (responseCache key includes the projectId).
 */
import { and, eq } from "drizzle-orm";
import { prisma } from "@peri-fuse/shared/src/db";
import { datasets } from "@peri-fuse/shared/src/db/schema/index.js";
import {
  createDataset,
  LangfuseNotFoundError,
  listDatasets,
  type DatasetCreateBody,
} from "@peri-fuse/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { CreateDatasetV2Schema, GetDatasetsV2QuerySchema } from "../schemas/datasets-v2";
import { toDatasetPublicApi } from "../shaping/datasets";

const app = new Hono<LiteServerEnv>();

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function meta(page: number, limit: number, totalItems: number) {
  return { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) };
}

/**
 * zod v4 widens every object key to optional in its output type when
 * strictNullChecks is disabled (this repo's tsconfig). `safeParse` success
 * guarantees the required fields at runtime, so a narrowing assertion here is
 * safe and keeps the domain function signatures strictly typed.
 */
function asCreateBody<T>(data: unknown): T {
  return data as T;
}

// GET /api/public/v2/datasets
app.get("/api/public/v2/datasets", authMiddleware, responseCache(2_000), async (c) => {
  const parsed = GetDatasetsV2QuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;
  const { items, totalItems } = await listDatasets(c.get("auth").scope.projectId, {
    page: query.page,
    limit: query.limit,
  });
  return c.json({
    data: items.map(toDatasetPublicApi),
    meta: meta(query.page, query.limit, totalItems),
  });
});

// POST /api/public/v2/datasets
app.post("/api/public/v2/datasets", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  const parsed = CreateDatasetV2Schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const dataset = await createDataset(
    c.get("auth").scope.projectId,
    asCreateBody<DatasetCreateBody>(parsed.data),
  );
  return c.json(toDatasetPublicApi(dataset), 200);
});

// GET /api/public/v2/datasets/{datasetName}
app.get("/api/public/v2/datasets/:datasetName", authMiddleware, responseCache(2_000), async (c) => {
  const projectId = c.get("auth").scope.projectId;
  const name = c.req.param("datasetName");
  const row = await prisma.query.datasets.findFirst({
    where: and(eq(datasets.projectId, projectId), eq(datasets.name, name)),
  });
  if (!row) {
    throw new LangfuseNotFoundError(`Dataset with name '${name}' not found`);
  }
  return c.json(toDatasetPublicApi(row));
});

export default app;
