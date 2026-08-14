/**
 * Eval configs public API integration tests (Phase 1 §4.3 E1-E10).
 *
 * Covers create → list → scoreName filter → get by id → PATCH → DELETE,
 * 404 semantics, same-scoreName version increments, and projectId isolation
 * (second project key created via prisma).
 *
 * NOTE: GETs are response-cached (2s TTL, key = projectId|path|query), so
 * assertions that must reflect post-write state use a distinct URL/key or
 * the write response itself.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiDelete, apiGet, apiPatch, apiPost } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";

const runId = randomUUID();
const scoreName = `ev-score-${runId}`;
const missingId = `ev-missing-${runId}`;

describe("eval configs public API", () => {
  let second: SecondProject;
  let configAId: string;
  let configBId: string;

  beforeAll(async () => {
    second = await createSecondProject();

    const a = await apiPost("/api/public/evals", {
      name: `eval-${runId}`,
      scoreName,
      targetObject: "trace",
      filter: [{ type: "string", key: "name", operator: "=", value: "seed" }],
      variableMapping: { input: "input" },
      sampling: 1,
      delay: 0,
      timeScope: ["NEW"],
      status: "ACTIVE",
    });
    expect(a.status).toBe(200);
    configAId = a.body.id;
    expect(a.body.version).toBe(1);

    const b = await apiPost("/api/public/evals/configs", {
      name: `eval-${runId}`,
      scoreName,
      targetObject: "observation",
      status: "ACTIVE",
    });
    expect(b.status).toBe(200);
    configBId = b.body.id;
    expect(b.body.version).toBe(2);
  });

  it("returns the created config with derived name and fields", async () => {
    const res = await apiGet(`/api/public/evals/configs/${configAId}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    // No template linked -> derived name falls back to scoreName (D1-B).
    expect(res.body.name).toBe(scoreName);
    expect(res.body.scoreName).toBe(scoreName);
    expect(res.body.targetObject).toBe("trace");
    expect(res.body.filter).toEqual([
      { type: "string", key: "name", operator: "=", value: "seed" },
    ]);
    expect(res.body.variableMapping).toEqual({ input: "input" });
    expect(res.body.sampling).toBe(1);
    expect(res.body.delay).toBe(0);
    expect(res.body.timeScope).toEqual(["NEW"]);
    expect(res.body.status).toBe("ACTIVE");
    expect(res.body.projectId).toBeTruthy();
    expect(typeof res.body.createdAt).toBe("string");
  });

  it("lists eval configs and filters by scoreName", async () => {
    const res = await apiGet(`/api/public/evals?scoreName=${encodeURIComponent(scoreName)}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.totalItems).toBe(2);
    expect(res.body.meta.page).toBe(1);
    const ids = res.body.data.map((c: any) => c.id).sort();
    expect(ids).toEqual([configAId, configBId].sort());
    const versions = res.body.data.map((c: any) => c.version).sort((x: number, y: number) => x - y);
    expect(versions).toEqual([1, 2]);
  });

  it("gets a config by id through both route aliases", async () => {
    const viaConfigs = await apiGet(`/api/public/evals/configs/${configBId}`);
    expect(viaConfigs.status).toBe(200);
    expect(viaConfigs.body.version).toBe(2);

    // Alias route (configA keeps the /evals/configs/ URL free for the
    // post-delete 404 check, which must bypass the 2s response cache).
    const viaAlias = await apiGet(`/api/public/evals/${configAId}`);
    expect(viaAlias.status).toBe(200);
    expect(viaAlias.body.id).toBe(configAId);
  });

  it("patches a config without changing the version", async () => {
    const res = await apiPatch(`/api/public/evals/configs/${configAId}`, {
      targetObject: "dataset_run_item",
      status: "INACTIVE",
      sampling: 0.5,
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(configAId);
    expect(res.body.targetObject).toBe("dataset_run_item");
    expect(res.body.status).toBe("INACTIVE");
    expect(res.body.sampling).toBe(0.5);
    // version is derived from createdAt ordering and never changes on PATCH.
    expect(res.body.version).toBe(1);
  });

  it("returns 404 for unknown eval config ids on get/patch/delete", async () => {
    expect((await apiGet(`/api/public/evals/${missingId}`)).status).toBe(404);
    expect(
      (await apiPatch(`/api/public/evals/configs/${missingId}`, { status: "ACTIVE" })).status,
    ).toBe(404);
    expect((await apiDelete(`/api/public/evals/configs/${missingId}`)).status).toBe(404);
  });

  it("rejects creation referencing an unknown eval template", async () => {
    const res = await apiPost("/api/public/evals", {
      name: `eval-tpl-${runId}`,
      scoreName: `ev-tpl-${runId}`,
      targetObject: "trace",
      evalTemplateId: `tpl-missing-${runId}`,
    });
    expect(res.status).toBe(404);
  });

  it("deletes a config and returns 404 afterwards", async () => {
    const del = await apiDelete(`/api/public/evals/configs/${configBId}`);
    expect(del.status).toBe(204);
    // Alias URL was never GET-cached, so this reflects the real post-delete state.
    expect((await apiGet(`/api/public/evals/${configBId}`)).status).toBe(404);
  });

  it("isolates eval configs per project", async () => {
    // The second project sees no configs of the first project.
    const list = await apiGet(
      `/api/public/evals?scoreName=${encodeURIComponent(scoreName)}`,
      second.auth,
    );
    expect(list.status).toBe(200);
    expect(list.body.meta.totalItems).toBe(0);
    expect(list.body.data).toEqual([]);

    expect((await apiGet(`/api/public/evals/configs/${configAId}`, second.auth)).status).toBe(404);
    expect((await apiPatch(`/api/public/evals/configs/${configAId}`, {}, second.auth)).status).toBe(
      404,
    );
    expect((await apiDelete(`/api/public/evals/${configAId}`, second.auth)).status).toBe(404);

    // Same scoreName in another project starts a fresh version sequence.
    const created = await apiPost(
      "/api/public/evals",
      {
        name: `eval-${runId}`,
        scoreName,
        targetObject: "trace",
      },
      {},
      second.auth,
    );
    expect(created.status).toBe(200);
    expect(created.body.version).toBe(1);
    expect(created.body.projectId).toBe(second.projectId);
  });
});
