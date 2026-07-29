/**
 * OTEL ingestion -> query roundtrip.
 *
 * Covers both OTLP encodings accepted by the route:
 *   - JSON (hand-built ResourceSpans, same shape as the e2e Python suite)
 *   - protobuf (encoded via the generated protobufjs root, the encoding the
 *     Python SDK v4+ uses by default)
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { $root } from "../otel-proto/root";
import { apiGet, apiPost, basicAuth, getApp } from "./helpers";

const ExportTraceServiceRequest =
  $root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

const nowNs = BigInt(Date.now()) * 1_000_000n;

/** Build a ResourceSpans payload with an agent + nested generation. */
function buildResourceSpans(traceIdHex: string, spanA: string, spanB: string) {
  return [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "otel-roundtrip" } }],
      },
      scopeSpans: [
        {
          scope: { name: "otel-roundtrip-scope" },
          spans: [
            {
              traceId: traceIdHex,
              spanId: spanA,
              name: "otel-rt-agent",
              kind: 1,
              startTimeUnixNano: nowNs.toString(),
              endTimeUnixNano: (nowNs + 500_000_000n).toString(),
              attributes: [
                {
                  key: "langfuse.observation.type",
                  value: { stringValue: "agent" },
                },
              ],
              status: {},
            },
            {
              traceId: traceIdHex,
              spanId: spanB,
              parentSpanId: spanA,
              name: "otel-rt-generation",
              kind: 1,
              startTimeUnixNano: (nowNs + 100_000_000n).toString(),
              endTimeUnixNano: (nowNs + 400_000_000n).toString(),
              attributes: [
                {
                  key: "langfuse.observation.type",
                  value: { stringValue: "generation" },
                },
                {
                  key: "gen_ai.request.model",
                  value: { stringValue: "gpt-4o-mini" },
                },
                {
                  key: "gen_ai.usage.input_tokens",
                  value: { intValue: "42" },
                },
                {
                  key: "gen_ai.usage.output_tokens",
                  value: { intValue: "18" },
                },
              ],
              status: {},
            },
          ],
        },
      ],
    },
  ];
}

async function verifyObservations(traceIdHex: string) {
  const res = await apiGet(`/api/public/observations?traceId=${traceIdHex}&limit=50`);
  expect(res.status).toBe(200);

  const byName = Object.fromEntries(res.body.data.map((o: any) => [o.name, o]));
  expect(byName["otel-rt-agent"]?.type).toBe("AGENT");
  expect(byName["otel-rt-generation"]?.type).toBe("GENERATION");
  expect(byName["otel-rt-generation"]?.model).toBe("gpt-4o-mini");
  expect(byName["otel-rt-generation"]?.parentObservationId).toBe(byName["otel-rt-agent"]?.id);
  expect(byName["otel-rt-generation"]?.usageDetails).toMatchObject({
    input: 42,
    output: 18,
  });
}

describe("OTEL JSON ingestion roundtrip", () => {
  const traceIdHex = randomUUID().replace(/-/g, "");

  beforeAll(async () => {
    const res = await apiPost("/api/public/otel/v1/traces", {
      resourceSpans: buildResourceSpans(
        traceIdHex,
        randomUUID().replace(/-/g, "").slice(0, 16),
        randomUUID().replace(/-/g, "").slice(0, 16),
      ),
    });
    expect(res.status).toBe(200);
    expect(res.body.errors ?? []).toEqual([]);
  });

  it("persists agent + generation with nesting, model, and usage", async () => {
    await verifyObservations(traceIdHex);
  });
});

describe("OTEL protobuf ingestion roundtrip", () => {
  const traceIdHex = randomUUID().replace(/-/g, "");

  beforeAll(async () => {
    const spanA = randomUUID().replace(/-/g, "").slice(0, 16);
    const spanB = randomUUID().replace(/-/g, "").slice(0, 16);

    // fromObject expects bytes fields as Uint8Array (or base64 strings).
    const toBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
    const payload = buildResourceSpans(traceIdHex, spanA, spanB);
    for (const rs of payload) {
      for (const ss of rs.scopeSpans) {
        for (const span of ss.spans) {
          (span as any).traceId = toBytes(span.traceId as string);
          (span as any).spanId = toBytes(span.spanId as string);
          if ((span as any).parentSpanId) {
            (span as any).parentSpanId = toBytes((span as any).parentSpanId);
          }
        }
      }
    }

    const message = ExportTraceServiceRequest.fromObject({
      resourceSpans: payload,
    });
    const encoded: Uint8Array = ExportTraceServiceRequest.encode(message).finish();

    const res = await getApp().request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: {
        Authorization: basicAuth(),
        "Content-Type": "application/x-protobuf",
      },
      body: encoded as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors ?? []).toEqual([]);
  });

  it("decodes protobuf spans and persists them like JSON ones", async () => {
    await verifyObservations(traceIdHex);
  });
});

describe("OTEL content-type validation", () => {
  it("rejects unsupported content types with 400", async () => {
    const res = await apiPost("/api/public/otel/v1/traces", "<xml/>", {
      "Content-Type": "text/xml",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid content type");
  });
});
