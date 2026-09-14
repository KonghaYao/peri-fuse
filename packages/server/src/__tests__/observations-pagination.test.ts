import { getTelemetryDB } from "@peri-fuse/shared/src/server";
import { describe, expect, it } from "vitest";
import { apiGet } from "./helpers";
import { createSecondProject } from "./second-project";

interface ObservationsResponse {
  data: Array<{
    id: string;
    type: string;
    level: string;
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    usage: { input: number; output: number; total: number };
  }>;
  meta: { page: number; limit: number; totalItems: number; totalPages: number };
}

describe("observations type and level pagination", () => {
  it("keeps exact totals, full SDK fields and project isolation on page two", async () => {
    const project = await createSecondProject();
    const otherProject = await createSecondProject();
    const records = Array.from({ length: 60 }, (_, i) => ({
      project_id: project.projectId,
      id: `error-${i}`,
      type: "GENERATION",
      level: "ERROR",
      start_time: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      input: JSON.stringify({ prompt: "keep SDK input" }),
      output: JSON.stringify({ message: "keep SDK output" }),
      metadata: JSON.stringify({ source: "pagination-test" }),
      usage_details: JSON.stringify({ input: 3, output: 2, total: 5 }),
    }));
    await getTelemetryDB().insert({
      table: "observations",
      records: [
        ...records,
        ...records.map((row) => ({ ...row, project_id: otherProject.projectId })),
        ...records.map((row) => ({ ...row, id: `span-${row.id}`, type: "SPAN" })),
        ...records.map((row) => ({ ...row, id: `ok-${row.id}`, level: "DEFAULT" })),
      ],
    });

    const path = "/api/public/observations?page=2&limit=25&type=GENERATION&level=ERROR";
    const { status, body } = await apiGet<ObservationsResponse>(path, project.auth);
    expect(status).toBe(200);
    expect(body.meta).toEqual({ page: 2, limit: 25, totalItems: 60, totalPages: 3 });
    expect(body.data.map((row) => row.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `error-${34 - i}`),
    );
    expect(body.data[0]).toMatchObject({
      type: "GENERATION",
      level: "ERROR",
      input: { prompt: "keep SDK input" },
      output: { message: "keep SDK output" },
      metadata: { source: "pagination-test" },
      usage: { input: 3, output: 2, total: 5 },
    });

    const summary = await apiGet<ObservationsResponse>(`${path}&fields=summary`, project.auth);
    expect(summary.status).toBe(200);
    expect(summary.body.meta).toEqual(body.meta);
    expect(summary.body.data.map((row) => row.id)).toEqual(body.data.map((row) => row.id));
    expect(summary.body.data[0]).not.toHaveProperty("input");
    expect(summary.body.data[0]).not.toHaveProperty("output");
    expect(summary.body.data[0]).not.toHaveProperty("metadata");
  });
});
