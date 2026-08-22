import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";

describe("GET /api/public/traces/metrics progressive fields", () => {
  it("omits trace IO when only aggregate metrics are requested", async () => {
    const traceId = `metrics-trace-${randomUUID()}`;
    const observationId = `metrics-observation-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const largeValue = "x".repeat(20_000);

    const ingestion = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp,
          body: {
            id: traceId,
            timestamp,
            input: largeValue,
            output: largeValue,
            metadata: { largeValue },
          },
        },
        {
          id: randomUUID(),
          type: "span-create",
          timestamp,
          body: {
            id: observationId,
            traceId,
            startTime: timestamp,
            endTime: timestamp,
            usageDetails: { input: 12, output: 3, total: 15 },
          },
        },
      ],
    });
    expect(ingestion.status).toBe(207);

    const compatible = await apiGet<any>(`/api/public/traces/metrics?traceIds=${traceId}`);
    const metricsOnly = await apiGet<any>(
      `/api/public/traces/metrics?traceIds=${traceId}&fields=metrics`,
    );
    const preview = await apiGet<any>(
      `/api/public/traces/metrics?traceIds=${traceId}&fields=metrics,io_preview`,
    );

    expect(compatible.status).toBe(200);
    expect(compatible.body[0].input).toBeDefined();
    expect(metricsOnly.status).toBe(200);
    expect(metricsOnly.body[0]).toMatchObject({
      id: traceId,
      observationCount: 1,
    });
    expect(metricsOnly.body[0]).not.toHaveProperty("input");
    expect(metricsOnly.body[0]).not.toHaveProperty("output");
    expect(metricsOnly.body[0]).not.toHaveProperty("metadata");
    expect(preview.body[0].input).toHaveLength(500);
    expect(preview.body[0].output).toHaveLength(500);
    expect(JSON.stringify(preview.body).length).toBeLessThan(
      JSON.stringify(compatible.body).length / 10,
    );
    expect(JSON.stringify(metricsOnly.body).length).toBeLessThan(
      JSON.stringify(compatible.body).length / 10,
    );
  });
});
