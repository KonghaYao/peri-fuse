import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiPost } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

describe("OTLP decompression budget", () => {
  it("rejects a small gzip body whose expanded data exceeds the budget", async () => {
    vi.stubEnv("LITE_MAX_DECOMPRESSED_BYTES", "1024");
    const compressed = gzipSync(JSON.stringify({ resourceSpans: [], padding: "x".repeat(10_000) }));
    expect(compressed.byteLength).toBeLessThan(1024);
    const response = await apiPost("/api/public/otel/v1/traces", compressed, {
      "Content-Type": "application/json",
      "content-encoding": "gzip",
    });
    expect(response.status).toBe(413);
  });

  it("accepts a compressed request within the budget", async () => {
    vi.stubEnv("LITE_MAX_DECOMPRESSED_BYTES", "1024");
    const response = await apiPost("/api/public/otel/v1/traces", gzipSync('{"resourceSpans":[]}'), {
      "Content-Type": "application/json",
      "content-encoding": "gzip",
    });
    expect(response.status).toBe(200);
  });
});
