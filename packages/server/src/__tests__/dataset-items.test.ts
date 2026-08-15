/**
 * v1 canonical dataset-items public API integration tests (CLI canonical, T7):
 * GET/POST /api/public/dataset-items, GET/DELETE /api/public/dataset-items/{id}.
 *
 * Covers the spec shapes (DatasetItem / PaginatedDatasetItems /
 * DeleteDatasetItemResponse), upsert-on-id versioning, list filters
 * (datasetName / sourceTraceId / version-without-datasetName → 400),
 * run-item cascade delete, and projectId isolation.
 *
 * GETs are response-cached (2s, key = projectId|path|query); post-write reads
 * use a distinct query (e.g. ?fresh=1) or a previously-unseen URL.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@peri-fuse/shared/src/db";
import { datasetItems } from "@peri-fuse/shared/src/db/schema/index.js";
import { createIngestionAttribution, processEventBatch } from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { apiDelete, apiGet, apiPost } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";
import { TEST_PROJECT_ID } from "./test-db-paths";

const runId = randomUUID();
const datasetName = `di-ds-${runId}`;
const itemId = `di-item-${runId}`;
const itemBId = `di-item-b-${runId}`;
const missingId = `di-missing-${runId}`;
const iso = new Date().toISOString();

const authCheck = {
  validKey: true,
  scope: { projectId: TEST_PROJECT_ID, accessLevel: "project", orgId: undefined },
} as const;

describe("v1 dataset-items public API", () => {
  let second: SecondProject;
  let datasetId: string;

  beforeAll(async () => {
    second = await createSecondProject();

    const dataset = await apiPost("/api/public/datasets", { name: datasetName });
    expect(dataset.status).toBe(200);
    datasetId = dataset.body.id;

    const created = await apiPost("/api/public/dataset-items", {
      datasetName,
      id: itemId,
      input: { q: "v1" },
      expectedOutput: { a: "x" },
      metadata: { owner: "tests" },
    });
    expect(created.status).toBe(200);
    expect(created.body.id).toBe(itemId);

    const createdB = await apiPost("/api/public/dataset-items", {
      datasetName,
      id: itemBId,
      input: { q: "b" },
    });
    expect(createdB.status).toBe(200);
    expect(createdB.body.id).toBe(itemBId);
  });

  it("creates items with the spec DatasetItem shape", async () => {
    const res = await apiGet(`/api/public/dataset-items/${itemId}?fresh=1`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(itemId);
    expect(res.body.status).toBe("ACTIVE");
    expect(res.body.input).toEqual({ q: "v1" });
    expect(res.body.expectedOutput).toEqual({ a: "x" });
    expect(res.body.metadata).toEqual({ owner: "tests" });
    expect(res.body.sourceTraceId).toBeNull();
    expect(res.body.sourceObservationId).toBeNull();
    expect(res.body.datasetId).toBe(datasetId);
    expect(res.body.datasetName).toBe(datasetName);
    expect(typeof res.body.createdAt).toBe("string");
    expect(typeof res.body.updatedAt).toBe("string");
    expect(res.body.mediaReferences).toEqual([]);
  });

  it("upserts on id (versioned re-write) and serves the newest version", async () => {
    const res = await apiPost("/api/public/dataset-items", {
      datasetName,
      id: itemBId,
      input: { q: "b2" },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(itemBId);
    expect(res.body.input).toEqual({ q: "b2" });

    const get = await apiGet(`/api/public/dataset-items/${itemBId}?fresh=2`);
    expect(get.status).toBe(200);
    expect(get.body.input).toEqual({ q: "b2" });

    // Both versions exist at the DB level; only one is current.
    const rows = await prisma
      .select()
      .from(datasetItems)
      .where(and(eq(datasetItems.id, itemBId), eq(datasetItems.projectId, TEST_PROJECT_ID)));
    expect(rows.filter((r) => r.validTo === null && !r.isDeleted)).toHaveLength(1);
  });

  it("accepts null input/expectedOutput/metadata (spec nullable)", async () => {
    const res = await apiPost("/api/public/dataset-items", {
      datasetName,
      input: null,
      expectedOutput: null,
      metadata: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.input).toBeNull();
    expect(res.body.expectedOutput).toBeNull();
    expect(res.body.metadata).toBeNull();
  });

  it("returns 404 when the datasetName does not exist", async () => {
    const res = await apiPost("/api/public/dataset-items", {
      datasetName: `di-ghost-${runId}`,
      input: { q: "x" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid body (missing datasetName)", async () => {
    const res = await apiPost("/api/public/dataset-items", { input: { q: "x" } });
    expect(res.status).toBe(400);
  });

  it("lists items with page/limit meta and datasetName filtering", async () => {
    const res = await apiGet(
      `/api/public/dataset-items?datasetName=${encodeURIComponent(datasetName)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(50);
    expect(res.body.meta.totalItems).toBe(3); // itemId + itemBId (v2) + null-input item
    const byId = new Map(res.body.data.map((i: any) => [i.id, i]));
    expect(byId.get(itemId).datasetName).toBe(datasetName);
    expect(byId.get(itemBId).input).toEqual({ q: "b2" });
  });

  it("lists items project-wide without datasetName", async () => {
    const res = await apiGet(`/api/public/dataset-items?page=1&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: any) => i.id)).toContain(itemId);
  });

  it("rejects version without datasetName with 400", async () => {
    const res = await apiGet(`/api/public/dataset-items?version=${encodeURIComponent(iso)}`);
    expect(res.status).toBe(400);
  });

  it("filters by sourceTraceId", async () => {
    const traceId = `di-st-${runId}`;
    const ingest = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: traceId, timestamp: iso, name: `di-st-${runId}` },
        },
      ],
    });
    expect(ingest.status).toBe(207);

    await apiPost("/api/public/dataset-items", {
      datasetName,
      input: { q: "st" },
      sourceTraceId: traceId,
    });

    const res = await apiGet(
      `/api/public/dataset-items?sourceTraceId=${encodeURIComponent(traceId)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.totalItems).toBe(1);
    expect(res.body.data[0].sourceTraceId).toBe(traceId);
  });

  it("deletes an item with 200 + message and cascades to its run items", async () => {
    // Create a run + run item pointing at itemId (same pattern as datasets.test.ts).
    const run = await apiPost(`/api/public/datasets/${datasetId}/runs`, {
      name: `di-run-${runId}`,
    });
    expect(run.status).toBe(200);
    const runIdValue = run.body.id;

    const traceId = `di-del-trace-${runId}`;
    const ingest = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: traceId, timestamp: iso, name: `di-del-trace-${runId}` },
        },
      ],
    });
    expect(ingest.status).toBe(207);

    const runItem = await processEventBatch(
      [
        {
          id: `di-run-item-${runId}`,
          type: "dataset-run-item-create",
          timestamp: iso,
          body: {
            id: `di-run-item-${runId}`,
            traceId,
            datasetId,
            runId: runIdValue,
            datasetItemId: itemId,
          },
        },
      ],
      authCheck,
      {
        isLangfuseInternal: true,
        attribution: createIngestionAttribution({ headers: {}, authCheck }),
      },
    );
    expect(runItem.errors).toEqual([]);

    const del = await apiDelete(`/api/public/dataset-items/${itemId}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ message: "Dataset item successfully deleted" });

    // Run items are soft-deleted too.
    const rows = await getTelemetryDB().query({
      query:
        "SELECT is_deleted FROM dataset_run_items WHERE project_id = @projectId AND dataset_item_id = @itemId",
      params: { projectId: TEST_PROJECT_ID, itemId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].is_deleted).toBe(1);
  });

  it("returns 404 for a deleted item on get/delete", async () => {
    // Distinct cache key from the earlier successful GET.
    expect((await apiGet(`/api/public/dataset-items/${itemId}?fresh=3`)).status).toBe(404);
    expect((await apiDelete(`/api/public/dataset-items/${itemId}`)).status).toBe(404);
  });

  it("returns 404 for an unknown item id", async () => {
    expect((await apiGet(`/api/public/dataset-items/${missingId}`)).status).toBe(404);
    expect((await apiDelete(`/api/public/dataset-items/${missingId}`)).status).toBe(404);
  });

  it("isolates items per project", async () => {
    // Second project cannot read/delete items of the first project...
    expect((await apiGet(`/api/public/dataset-items/${itemBId}`, second.auth)).status).toBe(404);
    expect((await apiDelete(`/api/public/dataset-items/${itemBId}`, second.auth)).status).toBe(404);
    // ...and cannot create against the first project's dataset name.
    const res = await apiPost(
      "/api/public/dataset-items",
      { datasetName, input: { q: "iso" } },
      {},
      second.auth,
    );
    expect(res.status).toBe(404);
  });
});
