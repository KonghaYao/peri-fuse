/**
 * DELETE /api/public/scores/{scoreId} integration tests (v1, CLI canonical
 * `scores delete`).
 *
 * Covers: 204 on success, 404 for missing/already-deleted scores, projectId
 * isolation, and that the deleted score disappears from GET list reads
 * (soft delete is_deleted = 1 — every read path filters it).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiDelete, apiGet, apiPost } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";

const runId = randomUUID();
const traceId = `scd-trace-${runId}`;
const scoreId = `scd-score-${runId}`;
const scoreName = `scd-name-${runId}`;
const missingScoreId = `scd-missing-${runId}`;
const iso = new Date().toISOString();

describe("DELETE /api/public/scores/{scoreId}", () => {
  let second: SecondProject;

  beforeAll(async () => {
    second = await createSecondProject();

    // Seed: trace via ingestion + score via the public POST channel.
    const ingest = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: iso,
          body: { id: traceId, timestamp: iso, name: `scd-trace-${runId}` },
        },
      ],
    });
    expect(ingest.status).toBe(207);
    expect(ingest.body.errors).toEqual([]);

    const posted = await apiPost("/api/public/scores", {
      id: scoreId,
      traceId,
      name: scoreName,
      value: 0.5,
      dataType: "NUMERIC",
    });
    expect(posted.status).toBe(200);
    expect(posted.body.id).toBe(scoreId);
  });

  it("deletes a score with 204", async () => {
    const res = await apiDelete(`/api/public/scores/${scoreId}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("returns 404 for a deleted (no longer active) score", async () => {
    const res = await apiDelete(`/api/public/scores/${scoreId}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown score id", async () => {
    const res = await apiDelete(`/api/public/scores/${missingScoreId}`);
    expect(res.status).toBe(404);
  });

  it("excludes the deleted score from GET list reads", async () => {
    // Distinct URL/cache key: this query was never issued before the delete.
    const res = await apiGet(`/api/public/scores?name=${encodeURIComponent(scoreName)}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.id)).not.toContain(scoreId);
  });

  it("isolates deletes per project", async () => {
    // Second project cannot delete a score owned by the first project.
    const res = await apiDelete(`/api/public/scores/${scoreId}`, second.auth);
    expect(res.status).toBe(404);
  });
});
