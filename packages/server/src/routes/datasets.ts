/**
 * Datasets public API routes (Phase 2 — SDK-compatible).
 *
 * POST/GET /api/public/datasets, GET/PATCH/DELETE /api/public/datasets/{datasetId},
 * POST/GET /api/public/datasets/{datasetId}/items,
 * GET/PATCH/DELETE /api/public/datasets/{datasetId}/items/{itemId},
 * POST/GET /api/public/datasets/{datasetId}/runs,
 * GET /api/public/datasets/{datasetId}/runs/{runId} (run items + scores).
 *
 * Errors are expressed with BaseError subclasses and mapped to HTTP codes by
 * the app-level onError (404 LangfuseNotFoundError, 409 LangfuseConflictError,
 * 400 InvalidRequestError). All reads are project-scoped and cacheable
 * (responseCache key includes the projectId).
 */

import { randomUUID } from "node:crypto";
import {
  countDatasetItemsByDataset,
  createDataset,
  createDatasetItems,
  createDatasetRun,
  createOrFetchDatasetRun,
  type DatasetCreateBody,
  DatasetCreateSchema,
  type DatasetItemCreateBody,
  DatasetItemCreateSchema,
  DatasetItemUpdateSchema,
  type DatasetRunCreateBody,
  DatasetRunCreateSchema,
  type DatasetRunItemCreateBody,
  DatasetRunItemCreateSchema,
  DatasetUpdateSchema,
  deleteDataset,
  deleteDatasetItem,
  GetDatasetItemsQuerySchema,
  GetDatasetRunsQuerySchema,
  GetDatasetsQuerySchema,
  getDatasetById,
  getDatasetItemById,
  getDatasetItemsCurrentVersions,
  getDatasetRunById,
  getDatasetRunItems,
  getRunItemScores,
  LangfuseNotFoundError,
  listDatasetItems,
  listDatasetRuns,
  listDatasets,
  liteGetObservationById,
  updateDataset,
  updateDatasetItem,
} from "@peri-fuse/shared";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import {
  assembleRunDetail,
  toDatasetItemPublicApi,
  toDatasetPublicApi,
  toDatasetRunPublicApi,
} from "../shaping/datasets";

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

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

app.post("/api/public/datasets", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  const parsed = DatasetCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const dataset = await createDataset(
    c.get("auth").scope.projectId,
    asCreateBody<DatasetCreateBody>(parsed.data),
  );
  return c.json(toDatasetPublicApi(dataset), 200);
});

app.get("/api/public/datasets", authMiddleware, responseCache(2_000), async (c) => {
  const parsed = GetDatasetsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;
  const { items, totalItems } = await listDatasets(c.get("auth").scope.projectId, query);
  return c.json({
    data: items.map(toDatasetPublicApi),
    meta: meta(query.page, query.limit, totalItems),
  });
});

app.get("/api/public/datasets/:datasetId", authMiddleware, responseCache(2_000), async (c) => {
  const dataset = await getDatasetById(c.get("auth").scope.projectId, c.req.param("datasetId"));
  return c.json(toDatasetPublicApi(dataset));
});

app.patch("/api/public/datasets/:datasetId", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  const parsed = DatasetUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const dataset = await updateDataset(
    c.get("auth").scope.projectId,
    c.req.param("datasetId"),
    parsed.data,
  );
  return c.json(toDatasetPublicApi(dataset));
});

app.delete("/api/public/datasets/:datasetId", authMiddleware, async (c) => {
  await deleteDataset(c.get("auth").scope.projectId, c.req.param("datasetId"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Dataset items (versioned writes, decision D1)
// ---------------------------------------------------------------------------

app.post("/api/public/datasets/:datasetId/items", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  if (body === undefined) {
    return c.json({ message: "Invalid request data" }, 400);
  }
  // SDK semantics: body is an array; accept a single object for convenience.
  const list = Array.isArray(body) ? body : [body];
  const parsed = z.array(DatasetItemCreateSchema).safeParse(list);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const items = await createDatasetItems(
    c.get("auth").scope.projectId,
    c.req.param("datasetId"),
    asCreateBody<DatasetItemCreateBody[]>(parsed.data),
  );
  return c.json(items.map(toDatasetItemPublicApi), 200);
});

app.get(
  "/api/public/datasets/:datasetId/items",
  authMiddleware,
  responseCache(2_000),
  async (c) => {
    const parsed = GetDatasetItemsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
    }
    const query = parsed.data;
    const { items, totalItems } = await listDatasetItems(
      c.get("auth").scope.projectId,
      c.req.param("datasetId"),
      query,
    );
    return c.json({
      data: items.map(toDatasetItemPublicApi),
      meta: meta(query.page, query.limit, totalItems),
    });
  },
);

app.patch("/api/public/datasets/:datasetId/items/:itemId", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  const parsed = DatasetItemUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const item = await updateDatasetItem(
    c.get("auth").scope.projectId,
    c.req.param("datasetId"),
    c.req.param("itemId"),
    parsed.data,
  );
  return c.json(toDatasetItemPublicApi(item));
});

app.delete("/api/public/datasets/:datasetId/items/:itemId", authMiddleware, async (c) => {
  await deleteDatasetItem(
    c.get("auth").scope.projectId,
    c.req.param("datasetId"),
    c.req.param("itemId"),
  );
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Dataset runs
// ---------------------------------------------------------------------------

app.post("/api/public/datasets/:datasetId/runs", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  const parsed = DatasetRunCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const projectId = c.get("auth").scope.projectId;
  const datasetId = c.req.param("datasetId");
  const run = await createDatasetRun(
    projectId,
    datasetId,
    asCreateBody<DatasetRunCreateBody>(parsed.data),
  );
  const counts = await countDatasetItemsByDataset(projectId, [datasetId]);
  return c.json(toDatasetRunPublicApi(run, counts.get(datasetId) ?? 0), 200);
});

app.get("/api/public/datasets/:datasetId/runs", authMiddleware, responseCache(2_000), async (c) => {
  const parsed = GetDatasetRunsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;
  const projectId = c.get("auth").scope.projectId;
  const datasetId = c.req.param("datasetId");
  const { items, totalItems } = await listDatasetRuns(projectId, datasetId, query);
  const counts = await countDatasetItemsByDataset(
    projectId,
    Array.from(new Set(items.map((run) => run.datasetId))),
  );
  return c.json({
    data: items.map((run) => toDatasetRunPublicApi(run, counts.get(run.datasetId) ?? 0)),
    meta: meta(query.page, query.limit, totalItems),
  });
});

app.get(
  "/api/public/datasets/:datasetId/runs/:runId",
  authMiddleware,
  responseCache(2_000),
  async (c) => {
    const projectId = c.get("auth").scope.projectId;
    const datasetId = c.req.param("datasetId");
    const run = await getDatasetRunById(projectId, datasetId, c.req.param("runId"));

    const [runItems, counts] = await Promise.all([
      getDatasetRunItems(projectId, run.id),
      countDatasetItemsByDataset(projectId, [datasetId]),
    ]);
    const traceIds = Array.from(new Set(runItems.map((item) => item.trace_id)));
    const [scoresByTrace, itemVersions] = await Promise.all([
      getRunItemScores(projectId, traceIds),
      getDatasetItemsCurrentVersions(
        projectId,
        runItems.map((item) => item.dataset_item_id),
      ),
    ]);

    return c.json({
      ...toDatasetRunPublicApi(run, counts.get(datasetId) ?? 0),
      items: assembleRunDetail(run, runItems, scoresByTrace, itemVersions),
    });
  },
);

// ---------------------------------------------------------------------------
// Dataset run items (POST /api/public/dataset-run-items)
// ---------------------------------------------------------------------------

/**
 * Create a dataset run item (upstream `datasetRunItems_create`). The run is
 * located-or-created by `runName`; the item is resolved by id across datasets;
 * the traceId is required but may be inferred from an observationId (older
 * SDKs). The run item row lives in the telemetry DB (`dataset_run_items`).
 */
app.post("/api/public/dataset-run-items", authMiddleware, async (c) => {
  const body = await readJsonBody(c);
  const parsed = DatasetRunItemCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const data = asCreateBody<DatasetRunItemCreateBody>(parsed.data);
  const projectId = c.get("auth").scope.projectId;

  const item = await getDatasetItemById(projectId, data.datasetItemId);
  if (!item) {
    throw new LangfuseNotFoundError(
      `Dataset item with id '${data.datasetItemId}' not found or has no active version`,
    );
  }

  // traceId is required; infer it from the observation when missing.
  let traceId = data.traceId ?? null;
  if (!traceId && data.observationId) {
    const obs = await liteGetObservationById(projectId, data.observationId);
    traceId = obs?.trace_id ?? null;
  }
  if (!traceId) {
    return c.json({ message: "Either traceId or a resolvable observationId is required" }, 400);
  }

  const run = await createOrFetchDatasetRun({
    projectId,
    datasetId: item.datasetId,
    name: data.runName,
    description: data.runDescription ?? undefined,
    metadata: data.metadata ?? undefined,
  });

  const now = new Date().toISOString();
  const runItemId = randomUUID();
  await getTelemetryDB().insert({
    table: "dataset_run_items",
    records: [
      {
        id: runItemId,
        project_id: projectId,
        dataset_run_id: run.id,
        dataset_item_id: item.id,
        dataset_id: item.datasetId,
        trace_id: traceId,
        observation_id: data.observationId ?? null,
        error: null,
        created_at: now,
        updated_at: now,
        is_deleted: 0,
      },
    ],
  });

  return c.json(
    {
      id: runItemId,
      datasetRunId: run.id,
      datasetRunName: run.name,
      datasetItemId: item.id,
      traceId,
      observationId: data.observationId ?? null,
      createdAt: now,
      updatedAt: now,
    },
    200,
  );
});

export default app;
