import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";

describe("GET /api/public/sessions/:sessionId progressive fields", () => {
  it("keeps the default response compatible while allowing the web UI to omit nested IO", async () => {
    const suffix = randomUUID();
    const traceId = `session-trace-${suffix}`;
    const observationId = `session-observation-${suffix}`;
    const sessionId = `session-${suffix}`;
    const timestamp = new Date().toISOString();
    const largeValue = "x".repeat(20_000);

    const ingestion = await apiPost("/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp,
          body: { id: traceId, sessionId, timestamp, input: largeValue, output: largeValue },
        },
        {
          id: randomUUID(),
          type: "span-create",
          timestamp,
          body: {
            id: observationId,
            traceId,
            startTime: timestamp,
            input: largeValue,
            output: largeValue,
            metadata: { largeValue },
          },
        },
      ],
    });
    expect(ingestion.status).toBe(207);

    const compatible = await apiGet<any>(`/api/public/sessions/${sessionId}`);
    const shell = await apiGet<any>(
      `/api/public/sessions/${sessionId}?includeObservations=false&includeIo=false`,
    );

    expect(compatible.status).toBe(200);
    expect(compatible.body.traces[0].observations).toHaveLength(1);
    expect(compatible.body.traces[0].observations[0].input).toBeDefined();
    expect(shell.status).toBe(200);
    expect(shell.body.traces[0].observations).toEqual([]);
    expect(shell.body.traces[0].input).toBeNull();
    expect(shell.body.traces[0].output).toBeNull();
    expect(JSON.stringify(shell.body).length).toBeLessThan(
      JSON.stringify(compatible.body).length / 10,
    );
  });
});
