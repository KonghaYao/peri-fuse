/**
 * POST /api/public/scores integration tests (Phase 1 §4.2 P1).
 *
 * Covers success (NUMERIC with/without configId), configId → 404, validation
 * 400s, GET roundtrip, ingestion-event vs POST channel parity, and projectId
 * isolation.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, apiPatch, apiPost } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";

const runId = randomUUID();
// Score config names are capped at 35 chars (ScoreConfigNameSchema).
const shortId = runId.replace(/-/g, "").slice(0, 12);
const configName = `scp-config-${shortId}`;
const archivedConfigName = `scp-archived-${shortId}`;
const ingestScoreName = `scp-ingest-${runId}`;

const traceA = `scp-trace-a-${runId}`;
const traceB = `scp-trace-b-${runId}`;
const traceC = `scp-trace-c-${runId}`;
const postedScoreId = `scp-score-${runId}`;
const iso = new Date().toISOString();

describe("POST /api/public/scores", () => {
  let second: SecondProject;
  let configId: string;
  let archivedConfigId: string;

  beforeAll(async () => {
    second = await createSecondProject();

    // NUMERIC config (min 0, max 1) + an archived config.
    const config = await apiPost("/api/public/score-configs", {
      name: configName,
      dataType: "NUMERIC",
      minValue: 0,
      maxValue: 1,
    });
    expect(config.status).toBe(200);
    configId = config.body.id;

    const archived = await apiPost("/api/public/score-configs", {
      name: archivedConfigName,
      dataType: "NUMERIC",
    });
    expect(archived.status).toBe(200);
    archivedConfigId = archived.body.id;
    const archivedPatch = await apiPatch(`/api/public/score-configs/${archivedConfigId}`, {
      isArchived: true,
    });
    expect(archivedPatch.status).toBe(200);
    expect(archivedPatch.body.isArchived).toBe(true);

    // Ingestion channel: trace + score (no configId).
    const ingest = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: traceA, timestamp: iso, name: `scp-trace-a-${runId}` },
        },
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: iso,
          body: {
            id: randomUUID(),
            traceId: traceA,
            name: ingestScoreName,
            value: 0.7,
            dataType: "NUMERIC",
          },
        },
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: traceB, timestamp: iso, name: `scp-trace-b-${runId}` },
        },
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: traceC, timestamp: iso, name: `scp-trace-c-${runId}` },
        },
      ],
    });
    expect(ingest.status).toBe(207);
    expect(ingest.body.errors).toEqual([]);

    // POST channel: score linked to the config (name must match config).
    const posted = await apiPost("/api/public/scores", {
      id: postedScoreId,
      traceId: traceB,
      name: configName,
      value: 0.5,
      dataType: "NUMERIC",
      configId,
    });
    expect(posted.status).toBe(200);
    expect(posted.body.id).toBe(postedScoreId);

    // POST channel without configId (name is kept as-is).
    const plain = await apiPost("/api/public/scores", {
      id: `scp-plain-${runId}`,
      traceId: traceC,
      name: `scp-plain-${runId}`,
      value: 0.25,
      dataType: "NUMERIC",
    });
    expect(plain.status).toBe(200);
    expect(plain.body.id).toBe(`scp-plain-${runId}`);
  });

  it("persists a config-linked score and overrides name from the config", async () => {
    const res = await apiGet(`/api/public/scores?traceId=${traceB}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const score = res.body.data[0];
    expect(score.id).toBe(postedScoreId);
    expect(score.name).toBe(configName);
    expect(score.value).toBeCloseTo(0.5);
    expect(score.dataType).toBe("NUMERIC");
    expect(score.configId).toBe(configId);
  });

  it("persists a score without configId", async () => {
    const res = await apiGet(`/api/public/scores?traceId=${traceC}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const score = res.body.data[0];
    expect(score.name).toBe(`scp-plain-${runId}`);
    expect(score.value).toBeCloseTo(0.25);
    expect(score.configId).toBeNull();
  });

  it("returns 404 when the configId does not exist", async () => {
    const res = await apiPost("/api/public/scores", {
      traceId: traceA,
      name: configName,
      value: 0.5,
      dataType: "NUMERIC",
      configId: `scp-no-config-${runId}`,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid payloads", async () => {
    // BOOLEAN value must be 0 or 1
    const badBoolean = await apiPost("/api/public/scores", {
      traceId: traceA,
      name: "x",
      value: 2,
      dataType: "BOOLEAN",
    });
    expect(badBoolean.status).toBe(400);

    // value outside the config range (min 0, max 1)
    const outOfRange = await apiPost("/api/public/scores", {
      traceId: traceA,
      name: configName,
      value: 5,
      dataType: "NUMERIC",
      configId,
    });
    expect(outOfRange.status).toBe(400);

    // name mismatch against the config
    const nameMismatch = await apiPost("/api/public/scores", {
      traceId: traceA,
      name: "some-other-name",
      value: 0.5,
      dataType: "NUMERIC",
      configId,
    });
    expect(nameMismatch.status).toBe(400);

    // ANNOTATION scores require a configId
    const noConfigAnnotation = await apiPost("/api/public/scores", {
      traceId: traceA,
      name: "x",
      value: 1,
      dataType: "NUMERIC",
      source: "ANNOTATION",
    });
    expect(noConfigAnnotation.status).toBe(400);

    // missing name
    const noName = await apiPost("/api/public/scores", {
      traceId: traceA,
      value: 1,
      dataType: "NUMERIC",
    });
    expect(noName.status).toBe(400);
  });

  it("rejects scores against an archived config", async () => {
    const res = await apiPost("/api/public/scores", {
      traceId: traceA,
      name: archivedConfigName,
      value: 0.5,
      dataType: "NUMERIC",
      configId: archivedConfigId,
    });
    expect(res.status).toBe(400);
  });

  it("roundtrips both ingestion and POST channels with the same shape", async () => {
    const viaIngestion = await apiGet(`/api/public/scores?traceId=${traceA}`);
    expect(viaIngestion.status).toBe(200);
    const viaPost = await apiGet(`/api/public/scores?traceId=${traceB}`);
    expect(viaPost.status).toBe(200);

    const [ingestScore, postScore] = [viaIngestion.body.data[0], viaPost.body.data[0]];
    expect(ingestScore.name).toBe(ingestScoreName);
    expect(ingestScore.value).toBeCloseTo(0.7);
    expect(ingestScore.dataType).toBe("NUMERIC");
    // Same source default for both channels.
    expect(ingestScore.source).toBe(postScore.source);
    // Both rows carry the same structural fields.
    expect(Object.keys(postScore).sort()).toEqual(Object.keys(ingestScore).sort());
  });

  it("isolates scores per project", async () => {
    const list = await apiGet(`/api/public/scores?traceId=${traceA}`, second.auth);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    // Second project can post its own score; first project still sees none.
    const posted = await apiPost(
      "/api/public/scores",
      { traceId: traceA, name: `scp-other-${runId}`, value: 1, dataType: "NUMERIC" },
      {},
      second.auth,
    );
    expect(posted.status).toBe(200);
    const firstProjectList = await apiGet(`/api/public/scores?traceId=${traceA}`);
    expect(firstProjectList.body.data.map((s: any) => s.id)).not.toContain(posted.body.id);
  });
});
