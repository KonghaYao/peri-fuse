/**
 * v2 datasets public API integration tests.
 *
 * Covers the spec surface: POST /api/public/v2/datasets (create with
 * inputSchema/expectedOutputSchema round-trip), GET /api/public/v2/datasets
 * (page/limit pagination meta) and GET /api/public/v2/datasets/{datasetName}
 * (lookup by name, 404 semantics), plus 409 duplicate names, 400 validation
 * and projectId isolation.
 *
 * The v2 routes are not yet mounted in app.ts (T6 wires them in), so this
 * suite builds its own minimal app (onError + datasets-v2 routes) instead of
 * reusing helpers.getApp(); the auth middleware only needs the test DB
 * prepared by global-setup.ts. GETs are response-cached (2s, key =
 * projectId|path|query), so each read uses a distinct URL/query key and
 * post-write reads rely on the write response or a first-time URL.
 */
import { randomUUID } from "node:crypto";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { LiteServerEnv } from "../auth";
import datasetsV2Routes from "../routes/datasets-v2";
import { basicAuth } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";
import { TEST_PROJECT_ID } from "./test-db-paths";

const runId = randomUUID();
const datasetName = `ds-v2-${runId}`;
const missingName = `ds-v2-missing-${runId}`;
const inputSchema = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};
const outputSchema = {
  type: "object",
  properties: { a: { type: "string" } },
};

let app: Hono<LiteServerEnv> | null = null;

function getV2App(): Hono<LiteServerEnv> {
  if (!app) {
    app = new Hono<LiteServerEnv>();
    app.onError((err, c) => {
      if (err instanceof LangfuseNotFoundError) {
        return c.json({ message: err.message }, 404);
      }
      if (err instanceof BaseError) {
        return c.json({ error: err.name, message: err.message }, err.httpCode as 500);
      }
      return c.json({ message: "Internal Server Error" }, 500);
    });
    app.route("/", datasetsV2Routes);
  }
  return app;
}

async function apiGet<T = any>(
  path: string,
  auth: string = basicAuth(),
): Promise<{
  status: number;
  body: T;
}> {
  const res = await getV2App().request(path, { headers: { Authorization: auth } });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function apiPost<T = any>(
  path: string,
  body: unknown,
  auth: string = basicAuth(),
): Promise<{ status: number; body: T }> {
  const res = await getV2App().request(path, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

describe("v2 datasets public API", () => {
  let second: SecondProject;
  let createdId: string;

  beforeAll(async () => {
    second = await createSecondProject();
  });

  it("creates a dataset with inputSchema/expectedOutputSchema (round-trip)", async () => {
    const res = await apiPost("/api/public/v2/datasets", {
      name: datasetName,
      description: "v2 seed dataset",
      metadata: { owner: "v2-tests" },
      inputSchema,
      expectedOutputSchema: outputSchema,
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(datasetName);
    expect(res.body.description).toBe("v2 seed dataset");
    expect(res.body.metadata).toEqual({ owner: "v2-tests" });
    expect(res.body.inputSchema).toEqual(inputSchema);
    expect(res.body.expectedOutputSchema).toEqual(outputSchema);
    expect(res.body.projectId).toBe(TEST_PROJECT_ID);
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.createdAt).toBe("string");
    expect(typeof res.body.updatedAt).toBe("string");
    createdId = res.body.id;
  });

  it("lists v2 datasets with pagination meta", async () => {
    const res = await apiGet("/api/public/v2/datasets?page=1&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual(
      expect.objectContaining({ page: 1, limit: 10, totalPages: expect.any(Number) }),
    );
    expect(res.body.meta.totalItems).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data)).toBe(true);
    const mine = res.body.data.find((d: { name: string }) => d.name === datasetName);
    expect(mine).toBeDefined();
    expect(mine.inputSchema).toEqual(inputSchema);
  });

  it("gets a dataset by name", async () => {
    const res = await apiGet(`/api/public/v2/datasets/${encodeURIComponent(datasetName)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdId);
    expect(res.body.name).toBe(datasetName);
    expect(res.body.inputSchema).toEqual(inputSchema);
    expect(res.body.expectedOutputSchema).toEqual(outputSchema);
  });

  it("returns 404 for an unknown dataset name", async () => {
    const res = await apiGet(`/api/public/v2/datasets/${encodeURIComponent(missingName)}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toContain(missingName);
  });

  it("is project-isolated: another project cannot read the dataset by name", async () => {
    const res = await apiGet(
      `/api/public/v2/datasets/${encodeURIComponent(datasetName)}`,
      second.auth,
    );
    expect(res.status).toBe(404);
  });

  it("rejects duplicate dataset names with 409", async () => {
    const res = await apiPost("/api/public/v2/datasets", { name: datasetName });
    expect(res.status).toBe(409);
  });

  it("rejects invalid create bodies with 400", async () => {
    // Missing required name.
    expect((await apiPost("/api/public/v2/datasets", {})).status).toBe(400);
    // `null` is not a valid root JSON literal for the schema fields (strings
    // are, so a bare string would pass validation).
    const resBadSchema = await apiPost("/api/public/v2/datasets", {
      name: datasetName,
      inputSchema: null,
    });
    expect(resBadSchema.status).toBe(400);
  });
});
