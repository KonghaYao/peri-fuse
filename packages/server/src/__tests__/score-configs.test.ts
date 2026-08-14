/**
 * Score configs public API integration tests (Phase 1 §4.1 S1-S4).
 *
 * Covers create → list → get by id → PATCH (incl. archive), 404 semantics,
 * validation 400s, same-name coexistence, and projectId isolation.
 *
 * NOTE: upstream has no DELETE / score-configs versioning (decision D2) —
 * "CRUD" here is create/read/update(+archive); same-name creates succeed as
 * independent configs. GETs are response-cached (2s, key = projectId|path|
 * query), so post-write assertions use the write response itself.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, apiPatch, apiPost } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";

const runId = randomUUID();
// Score config names are capped at 35 chars (ScoreConfigNameSchema).
const shortId = runId.replace(/-/g, "").slice(0, 12);
const name = `sc-${shortId}`;
const missingId = `sc-missing-${shortId}`;

describe("score configs public API", () => {
  let second: SecondProject;
  let configAId: string;
  let configBId: string;
  let categoricalId: string;

  beforeAll(async () => {
    second = await createSecondProject();

    const a = await apiPost("/api/public/score-configs", {
      name,
      dataType: "NUMERIC",
      minValue: 0,
      maxValue: 1,
      description: "seed config",
    });
    expect(a.status).toBe(200);
    configAId = a.body.id;
    expect(a.body.isArchived).toBe(false);

    // Same-name create is allowed (no name uniqueness constraint).
    const b = await apiPost("/api/public/score-configs", {
      name,
      dataType: "NUMERIC",
    });
    expect(b.status).toBe(200);
    configBId = b.body.id;

    const c = await apiPost("/api/public/score-configs", {
      name: `${name}-cat`,
      dataType: "CATEGORICAL",
      categories: [
        { label: "good", value: 1 },
        { label: "bad", value: 0 },
      ],
    });
    expect(c.status).toBe(200);
    categoricalId = c.body.id;
  });

  it("returns the created config with full shape", async () => {
    const res = await apiGet(`/api/public/score-configs/${configAId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(configAId);
    expect(res.body.name).toBe(name);
    expect(res.body.dataType).toBe("NUMERIC");
    expect(res.body.isArchived).toBe(false);
    expect(res.body.minValue).toBe(0);
    expect(res.body.maxValue).toBe(1);
    expect(res.body.description).toBe("seed config");
    expect(res.body.projectId).toBeTruthy();
    expect(typeof res.body.createdAt).toBe("string");
    expect(res.body.categories).toBeUndefined();
  });

  it("coexists same-name configs as independent configs", async () => {
    expect(configAId).not.toBe(configBId);
    const a = await apiGet(`/api/public/score-configs/${configAId}`);
    const b = await apiGet(`/api/public/score-configs/${configBId}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.name).toBe(b.body.name);
  });

  it("lists score configs with pagination meta", async () => {
    const res = await apiGet("/api/public/score-configs?page=1&limit=50");
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(50);
    const ids = res.body.data.map((c: any) => c.id);
    expect(ids).toContain(configAId);
    expect(ids).toContain(configBId);
    expect(ids).toContain(categoricalId);
    expect(res.body.meta.totalItems).toBeGreaterThanOrEqual(3);
  });

  it("patches a config (rename, range, archive)", async () => {
    const res = await apiPatch(`/api/public/score-configs/${configAId}`, {
      name: `${name}-renamed`,
      minValue: 0.2,
      maxValue: 0.9,
      isArchived: true,
      description: "updated",
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`${name}-renamed`);
    expect(res.body.minValue).toBe(0.2);
    expect(res.body.maxValue).toBe(0.9);
    expect(res.body.isArchived).toBe(true);
    expect(res.body.description).toBe("updated");
    expect(res.body.dataType).toBe("NUMERIC");
  });

  it("returns 404 for unknown config ids on get/patch", async () => {
    expect((await apiGet(`/api/public/score-configs/${missingId}`)).status).toBe(404);
    expect(
      (await apiPatch(`/api/public/score-configs/${missingId}`, { isArchived: true })).status,
    ).toBe(404);
  });

  it("returns 400 for invalid create payloads", async () => {
    // categories on a NUMERIC config
    const withCategories = await apiPost("/api/public/score-configs", {
      name: `${name}-bad1`,
      dataType: "NUMERIC",
      categories: [{ label: "x", value: 1 }],
    });
    expect(withCategories.status).toBe(400);

    // maxValue <= minValue
    const badRange = await apiPost("/api/public/score-configs", {
      name: `${name}-bad2`,
      dataType: "NUMERIC",
      minValue: 1,
      maxValue: 1,
    });
    expect(badRange.status).toBe(400);

    // name longer than 35 chars
    const longName = await apiPost("/api/public/score-configs", {
      name: "a".repeat(36),
      dataType: "TEXT",
    });
    expect(longName.status).toBe(400);

    // BOOLEAN categories must be exactly [True/1, False/0]
    const badBoolean = await apiPost("/api/public/score-configs", {
      name: `${name}-bad4`,
      dataType: "BOOLEAN",
      categories: [{ label: "Yes", value: 1 }],
    });
    expect(badBoolean.status).toBe(400);

    // CATEGORICAL without categories
    const noCategories = await apiPost("/api/public/score-configs", {
      name: `${name}-bad5`,
      dataType: "CATEGORICAL",
    });
    expect(noCategories.status).toBe(400);
  });

  it("returns 400 when patching data-type-incompatible fields", async () => {
    const res = await apiPatch(`/api/public/score-configs/${configBId}`, {
      categories: [{ label: "x", value: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("isolates score configs per project", async () => {
    const list = await apiGet("/api/public/score-configs?page=1&limit=50", second.auth);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((c: any) => c.id);
    expect(ids).not.toContain(configAId);
    expect(ids).not.toContain(categoricalId);

    expect((await apiGet(`/api/public/score-configs/${configAId}`, second.auth)).status).toBe(404);
    expect((await apiPatch(`/api/public/score-configs/${configAId}`, {}, second.auth)).status).toBe(
      404,
    );

    // The second project can create the same config name independently.
    const created = await apiPost(
      "/api/public/score-configs",
      {
        name,
        dataType: "NUMERIC",
      },
      {},
      second.auth,
    );
    expect(created.status).toBe(200);
    expect(created.body.projectId).toBe(second.projectId);
  });
});
