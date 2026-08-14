/**
 * Datasets public API integration tests (Phase 2).
 *
 * Covers datasets/items/runs CRUD: create → items (versioned re-writes,
 * close-old/insert-new) → runs → run detail (items + trace scores),
 * 409 on duplicate names, 404 semantics, and projectId isolation.
 *
 * Run items are written through `processEventBatch` with
 * `isLangfuseInternal: true` — the public ingestion endpoint rejects
 * `dataset-run-item-create` (asserted below), matching upstream's
 * internal-only contract. GETs are response-cached (2s, key = projectId|path|
 * query), so post-write reads use a distinct URL/key or the write response.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@peri-fuse/shared/src/db";
import { datasetItems } from "@peri-fuse/shared/src/db/schema/index.js";
import { createIngestionAttribution, processEventBatch } from "@peri-fuse/shared/src/server";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { apiDelete, apiGet, apiPatch, apiPost } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";
import { TEST_PROJECT_ID } from "./test-db-paths";

const runId = randomUUID();
const datasetName = `ds-${runId}`;
const itemA = `ds-item-a-${runId}`;
const itemB = `ds-item-b-${runId}`;
const runName = `ds-run-${runId}`;
const missingId = `ds-missing-${runId}`;
const iso = new Date().toISOString();

const authCheck = {
  validKey: true,
  scope: { projectId: TEST_PROJECT_ID, accessLevel: "project", orgId: undefined },
} as const;

describe("datasets public API", () => {
  let second: SecondProject;
  let datasetId: string;
  let createdRunId: string;

  beforeAll(async () => {
    second = await createSecondProject();

    const created = await apiPost("/api/public/datasets", {
      name: datasetName,
      description: "seed dataset",
      metadata: { owner: "tests" },
    });
    expect(created.status).toBe(200);
    datasetId = created.body.id;

    // Two items: itemA drives the versioning assertions, itemB the soft delete.
    const items = await apiPost(`/api/public/datasets/${datasetId}/items`, [
      { id: itemA, input: { q: "v1" }, expectedOutput: { a: "x" } },
      { id: itemB, input: { q: "b" } },
    ]);
    expect(items.status).toBe(200);
    expect(items.body).toHaveLength(2);
  });

  it("creates a dataset with the full public shape", async () => {
    const res = await apiGet(`/api/public/datasets/${datasetId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(datasetId);
    expect(res.body.name).toBe(datasetName);
    expect(res.body.description).toBe("seed dataset");
    expect(res.body.metadata).toEqual({ owner: "tests" });
    expect(res.body.projectId).toBe(TEST_PROJECT_ID);
    expect(typeof res.body.createdAt).toBe("string");
    expect(typeof res.body.updatedAt).toBe("string");
  });

  it("rejects duplicate dataset names with 409", async () => {
    const res = await apiPost("/api/public/datasets", { name: datasetName });
    expect(res.status).toBe(409);
  });

  it("lists datasets and filters by name", async () => {
    const res = await apiGet(`/api/public/datasets?name=${encodeURIComponent(datasetName)}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.totalItems).toBe(1);
    expect(res.body.data[0].id).toBe(datasetId);
  });

  it("patches a dataset", async () => {
    const res = await apiPatch(`/api/public/datasets/${datasetId}`, {
      description: "patched",
      metadata: { owner: "patched" },
    });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("patched");
    expect(res.body.metadata).toEqual({ owner: "patched" });
  });

  it("returns 404 for unknown datasets on get/patch/delete", async () => {
    expect((await apiGet(`/api/public/datasets/${missingId}`)).status).toBe(404);
    expect((await apiPatch(`/api/public/datasets/${missingId}`, {})).status).toBe(404);
    expect((await apiDelete(`/api/public/datasets/${missingId}`)).status).toBe(404);
  });

  it("versions items when re-posting the same id", async () => {
    const res = await apiPost(`/api/public/datasets/${datasetId}/items`, [
      { id: itemA, input: { q: "v2" } },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].input).toEqual({ q: "v2" });

    // GET returns only the current version: itemA (v2) + itemB.
    const list = await apiGet(`/api/public/datasets/${datasetId}/items?page=1&limit=50`);
    expect(list.status).toBe(200);
    expect(list.body.meta.totalItems).toBe(2);
    const byId = new Map(list.body.data.map((i: any) => [i.id, i]));
    expect(byId.get(itemA).input).toEqual({ q: "v2" });

    // DB-level: the old version row is closed (validTo set).
    const rows = await prisma
      .select()
      .from(datasetItems)
      .where(and(eq(datasetItems.id, itemA), eq(datasetItems.projectId, TEST_PROJECT_ID)));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.validTo !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.validTo === null && !r.isDeleted)).toHaveLength(1);
  });

  it("versions items on PATCH", async () => {
    const res = await apiPatch(`/api/public/datasets/${datasetId}/items/${itemA}`, {
      input: { q: "v3" },
    });
    expect(res.status).toBe(200);
    expect(res.body.input).toEqual({ q: "v3" });

    const rows = await prisma
      .select()
      .from(datasetItems)
      .where(and(eq(datasetItems.id, itemA), eq(datasetItems.projectId, TEST_PROJECT_ID)));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.validTo === null && !r.isDeleted)).toHaveLength(1);
  });

  it("soft-deletes items", async () => {
    const del = await apiDelete(`/api/public/datasets/${datasetId}/items/${itemB}`);
    expect(del.status).toBe(204);

    // Distinct cache key from the earlier items list.
    const list = await apiGet(`/api/public/datasets/${datasetId}/items?status=ACTIVE&limit=50`);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((i: any) => i.id);
    expect(ids).toContain(itemA);
    expect(ids).not.toContain(itemB);

    // PATCH on a deleted item (no active version) → 404.
    expect((await apiPatch(`/api/public/datasets/${datasetId}/items/${itemB}`, {})).status).toBe(
      404,
    );
  });

  it("returns 404 when posting items to an unknown dataset", async () => {
    const res = await apiPost(`/api/public/datasets/${missingId}/items`, [{ input: { q: "x" } }]);
    expect(res.status).toBe(404);
  });

  it("creates and lists runs; rejects duplicate run names with 409", async () => {
    const created = await apiPost(`/api/public/datasets/${datasetId}/runs`, {
      name: runName,
      description: "seed run",
    });
    expect(created.status).toBe(200);
    createdRunId = created.body.id;
    expect(created.body.datasetId).toBe(datasetId);
    // itemB was soft-deleted; itemA's current version is the only active one.
    expect(created.body.itemCount).toBe(1);

    const dup = await apiPost(`/api/public/datasets/${datasetId}/runs`, { name: runName });
    expect(dup.status).toBe(409);

    const list = await apiGet(`/api/public/datasets/${datasetId}/runs?page=1&limit=50`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: any) => r.id)).toContain(createdRunId);
  });

  it("returns 404 for unknown runs", async () => {
    const res = await apiGet(`/api/public/datasets/${datasetId}/runs/${missingId}`);
    expect(res.status).toBe(404);
  });

  it("returns run detail with run items and trace scores", async () => {
    // Trace + score go through the public ingestion channel.
    const runTraceId = `ds-run-trace-${runId}`;
    const runScoreName = `ds-run-score-${runId}`;
    const runItemId = `ds-run-item-${runId}`;
    const ingest = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: runTraceId, timestamp: iso, name: `ds-run-trace-${runId}` },
        },
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: iso,
          body: {
            id: randomUUID(),
            traceId: runTraceId,
            name: runScoreName,
            value: 0.9,
            dataType: "NUMERIC",
          },
        },
      ],
    });
    expect(ingest.status).toBe(207);
    expect(ingest.body.errors).toEqual([]);

    // The run-item event is internal-only: write via processEventBatch with
    // isLangfuseInternal: true (same lite write path as the HTTP route).
    const runItem = await processEventBatch(
      [
        {
          id: runItemId,
          type: "dataset-run-item-create",
          timestamp: iso,
          body: {
            id: runItemId,
            traceId: runTraceId,
            datasetId,
            runId: createdRunId,
            datasetItemId: itemA,
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

    const res = await apiGet(`/api/public/datasets/${datasetId}/runs/${createdRunId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdRunId);
    expect(res.body.name).toBe(runName);
    expect(res.body.itemCount).toBe(1);
    expect(res.body.items).toHaveLength(1);

    const item = res.body.items[0];
    expect(item.id).toBe(runItemId);
    expect(item.datasetRunId).toBe(createdRunId);
    expect(item.datasetItemId).toBe(itemA);
    expect(item.traceId).toBe(runTraceId);
    expect(item.datasetRunName).toBe(runName);
    // Current item version payload (v3) is joined into the detail.
    expect(item.datasetItemInput).toEqual({ q: "v3" });
    expect(typeof item.datasetItemVersion).toBe("string");
    // Scores are joined by trace id (decision D3).
    expect(item.scores).toHaveLength(1);
    expect(item.scores[0].name).toBe(runScoreName);
    expect(item.scores[0].value).toBeCloseTo(0.9);
  });

  it("rejects dataset-run-item-create through the public ingestion endpoint", async () => {
    const res = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "dataset-run-item-create",
          timestamp: iso,
          body: {
            traceId: `ds-public-trace-${runId}`,
            datasetId,
            runId: createdRunId,
            datasetItemId: itemA,
          },
        },
      ],
    });
    expect(res.status).toBe(207);
    expect(res.body.successes).toEqual([]);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].status).toBe(400);
  });

  it("isolates datasets per project", async () => {
    expect((await apiGet(`/api/public/datasets/${datasetId}`, second.auth)).status).toBe(404);

    const list = await apiGet("/api/public/datasets?page=1&limit=50", second.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.map((d: any) => d.id)).not.toContain(datasetId);

    // Same dataset name is available in the second project.
    const created = await apiPost("/api/public/datasets", { name: datasetName }, {}, second.auth);
    expect(created.status).toBe(200);
    expect(created.body.projectId).toBe(second.projectId);
    expect(created.body.id).not.toBe(datasetId);
  });
});
