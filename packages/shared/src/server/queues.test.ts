import { describe, expect, it } from "vitest";

import { IngestionEvent, OtelIngestionEvent, WebhookOutboundEnvelopeSchema } from "./queues";

const validMonitorEnvelope = {
  type: "monitor-alert" as const,
  monitorId: "mon_01",
  projectId: "proj_01",
  timestamp: new Date("2026-05-18T12:01:00.000Z"),
};

describe("WebhookOutboundEnvelopeSchema (discriminated union)", () => {
  it("parses a monitor-alert envelope", () => {
    const parsed = WebhookOutboundEnvelopeSchema.safeParse(validMonitorEnvelope);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "monitor-alert") {
      expect(parsed.data.monitorId).toBe("mon_01");
    }
  });

  it("rejects an unknown discriminator", () => {
    expect(WebhookOutboundEnvelopeSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  it("rejects a monitor-alert envelope with missing projectId", () => {
    const { projectId: _unused, ...withoutProjectId } = validMonitorEnvelope;
    expect(WebhookOutboundEnvelopeSchema.safeParse(withoutProjectId).success).toBe(false);
  });
});

describe("ingestion queue payload compatibility", () => {
  it("accepts ingestion jobs created before attribution fields existed", () => {
    const parsed = IngestionEvent.safeParse({
      data: {
        type: "trace-create",
        eventBodyId: "trace-01",
        fileKey: "event-01",
      },
      authCheck: {
        validKey: true,
        scope: {
          projectId: "project-01",
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts otel jobs with omitted attribution fields", () => {
    const parsed = OtelIngestionEvent.safeParse({
      data: {
        fileKey: "otel-01",
      },
      authCheck: {
        validKey: true,
        scope: {
          projectId: "project-01",
          accessLevel: "project",
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});
