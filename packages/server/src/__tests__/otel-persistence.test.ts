import type { Context, Next } from "hono";
import { expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    c.set("auth", { scope: { projectId: "synthetic" } });
    await next();
  },
}));
vi.mock("@peri-fuse/shared/src/server", () => ({
  createIngestionAttribution: () => ({}),
  getLangfuseHeaderValue: () => undefined,
  markProjectAsOtelUser: async () => {},
  logger: { error: vi.fn(), warn: vi.fn() },
  OtelIngestionProcessor: class {
    async publishToOtelIngestionQueue() {
      return { successes: [], errors: [{ id: "synthetic", status: 500 }] };
    }
  },
}));

import { $root } from "../otel-proto/root";
import app from "../routes/otel";

it.each(["application/json", "application/x-protobuf"])(
  "%s 落库失败返回可重试状态",
  async (contentType) => {
    const request = { resourceSpans: [{ scopeSpans: [] }] };
    const body =
      contentType === "application/json"
        ? JSON.stringify(request)
        : Buffer.from(
            $root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.encode(
              request,
            ).finish(),
          );
    const result = await app.request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "Failed to persist telemetry" });
  },
);
