/**
 * V1 canonical dataset-items public API routes (CLI canonical, T7).
 *
 * GET/POST /api/public/dataset-items, GET/DELETE /api/public/dataset-items/{id}
 * per the upstream v4.10.0 spec (`DatasetItem`, `CreateDatasetItemRequest`,
 * `PaginatedDatasetItems`, `DeleteDatasetItemResponse`).
 *
 * Semantics:
 *  - POST addresses the dataset by name (404 when missing) and upserts on
 *    `id` (versioned writes, decision D1 — re-posting an id closes the current
 *    version and inserts a new one).
 *  - GET list: optional datasetName / sourceTraceId / sourceObservationId /
 *    version (point-in-time, requires datasetName) filters; without version
 *    only current versions are returned.
 *  - GET/DELETE by id are project-scoped, 404 when no current version exists.
 *  - DELETE also removes the item's run items (soft delete in the telemetry
 *    DB) and returns 200 + `{ message }` per the spec (not 204).
 *
 * Errors use BaseError subclasses mapped by the app-level onError
 * (LangfuseNotFoundError → 404, InvalidRequestError → 400). Reads are
 * response-cached (key includes the projectId).
 */

import {
  createDatasetItems,
  type DatasetItemCreateBody,
  deleteDatasetItem,
  getDatasetById,
  getDatasetByName,
  getDatasetItemById,
  LangfuseNotFoundError,
  listDatasetItemsV1,
} from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { datasets } from "@peri-fuse/shared/src/db/schema/index.js";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { responseCache } from "../response-cache";
import { CreateDatasetItemV1Body, GetDatasetItemsV1Query } from "../schemas/dataset-items";
import { toDatasetItemV1PublicApi } from "../shaping/datasets";

const app = new Hono<LiteServerEnv>();

/** zod v4 widens optional keys; safeParse success guarantees them (see datasets.ts). */
function asCreateBody<T>(data: unknown): T {
  return data as T;
}

function meta(page: number, limit: number, totalItems: number) {
  return { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) };
}

/** Resolve dataset names for a set of ids (same project). */
async function datasetNamesById(projectId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();
  const rows = await prisma
    .select({ id: datasets.id, name: datasets.name })
    .from(datasets)
    .where(and(eq(datasets.projectId, projectId), inArray(datasets.id, unique)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

// ---------------------------------------------------------------------------
// POST /api/public/dataset-items
// ---------------------------------------------------------------------------

app.post("/api/public/dataset-items", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ message: "Invalid request data", errors: ["Invalid JSON body"] }, 400);
  }

  const parsed = CreateDatasetItemV1Body.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  const dataset = await getDatasetByName(projectId, body.datasetName);
  if (!dataset) {
    throw new LangfuseNotFoundError(`Dataset with name '${body.datasetName}' not found`);
  }

  const items = await createDatasetItems(
    projectId,
    dataset.id,
    asCreateBody<DatasetItemCreateBody[]>([
      {
        id: body.id ?? undefined,
        input: body.input ?? null,
        expectedOutput: body.expectedOutput ?? undefined,
        metadata: body.metadata ?? undefined,
        sourceTraceId: body.sourceTraceId ?? undefined,
        sourceObservationId: body.sourceObservationId ?? undefined,
      },
    ]),
  );

  return c.json(toDatasetItemV1PublicApi(items[0], dataset.name), 200);
});

// ---------------------------------------------------------------------------
// GET /api/public/dataset-items
// ---------------------------------------------------------------------------

app.get("/api/public/dataset-items", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;

  const parsed = GetDatasetItemsV1Query.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ message: "Invalid request data", error: parsed.error.issues }, 400);
  }
  const query = parsed.data;

  if (query.version !== undefined && !query.datasetName) {
    return c.json(
      { message: "Invalid request data", error: [{ message: "version requires datasetName" }] },
      400,
    );
  }

  let datasetId: string | undefined;
  if (query.datasetName) {
    const dataset = await getDatasetByName(projectId, query.datasetName);
    if (!dataset) {
      throw new LangfuseNotFoundError(`Dataset with name '${query.datasetName}' not found`);
    }
    datasetId = dataset.id;
  }

  const { items, totalItems } = await listDatasetItemsV1(projectId, {
    datasetId,
    sourceTraceId: query.sourceTraceId ?? undefined,
    sourceObservationId: query.sourceObservationId ?? undefined,
    version: query.version ? new Date(query.version) : undefined,
    page: query.page,
    limit: query.limit,
  });

  const names = await datasetNamesById(
    projectId,
    items.map((item) => item.datasetId),
  );

  return c.json({
    data: items.map((item) => toDatasetItemV1PublicApi(item, names.get(item.datasetId) ?? "")),
    meta: meta(query.page, query.limit, totalItems),
  });
});

// ---------------------------------------------------------------------------
// GET /api/public/dataset-items/{id}
// ---------------------------------------------------------------------------

app.get("/api/public/dataset-items/:id", authMiddleware, responseCache(2_000), async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const itemId = c.req.param("id");

  const item = await getDatasetItemById(projectId, itemId);
  if (!item) {
    throw new LangfuseNotFoundError(`Dataset item with id '${itemId}' not found`);
  }
  const dataset = await getDatasetById(projectId, item.datasetId);
  return c.json(toDatasetItemV1PublicApi(item, dataset.name));
});

// ---------------------------------------------------------------------------
// DELETE /api/public/dataset-items/{id}
// ---------------------------------------------------------------------------

app.delete("/api/public/dataset-items/:id", authMiddleware, async (c) => {
  const auth = c.get("auth");
  const projectId = auth.scope.projectId;
  const itemId = c.req.param("id");

  const item = await getDatasetItemById(projectId, itemId);
  if (!item) {
    throw new LangfuseNotFoundError(`Dataset item with id '${itemId}' not found`);
  }

  // Delete the item's run items too ("all its run items", spec). Run items
  // live in the telemetry DB; reads filter is_deleted = 0, so a soft delete
  // is equivalent here.
  await getTelemetryDB().command({
    query:
      "UPDATE dataset_run_items SET is_deleted = 1, updated_at = @now WHERE project_id = @projectId AND dataset_item_id = @itemId AND is_deleted = 0",
    params: {
      projectId,
      itemId,
      now: new Date().toISOString().replace("T", " ").replace("Z", ""),
    },
  });

  await deleteDatasetItem(projectId, item.datasetId, itemId);

  // Spec: 200 + DeleteDatasetItemResponse { message } (not 204).
  return c.json({ message: "Dataset item successfully deleted" }, 200);
});

export default app;
