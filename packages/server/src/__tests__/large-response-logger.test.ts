import type {
  AuthHeaderValidVerificationResultIngestion,
  AuthScope,
} from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { LiteServerEnv } from "../auth";
import { type LargeResponseLog, largeResponseLogger } from "../large-response-logger";

function makeApp(write: (entry: LargeResponseLog) => void): Hono<LiteServerEnv> {
  const app = new Hono<LiteServerEnv>();
  app.use("*", largeResponseLogger({ thresholdBytes: 10, write }));
  app.use("*", async (c, next) => {
    c.set("auth", {
      validKey: true,
      scope: { projectId: "project-1", accessLevel: "project" },
    } as AuthHeaderValidVerificationResultIngestion & { scope: AuthScope });
    await next();
  });
  app.get("/api/public/big", (c) => {
    c.header("X-Cache", "SKIP");
    return c.body("1234567890!");
  });
  app.get("/api/public/small", (c) => c.body("small"));
  app.get("/not-api", (c) => c.body("1234567890!"));
  return app;
}

describe("largeResponseLogger", () => {
  it("logs completed API responses above the threshold without query data", async () => {
    const write = vi.fn<(entry: LargeResponseLog) => void>();
    const response = await makeApp(write).request("/api/public/big?secret=hidden");

    expect(await response.text()).toBe("1234567890!");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      event: "large_api_response",
      method: "GET",
      path: "/api/public/big",
      status: 200,
      bytes: 11,
      projectId: "project-1",
      cache: "SKIP",
    });
    expect(write.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not log small or non-API responses", async () => {
    const write = vi.fn<(entry: LargeResponseLog) => void>();
    const app = makeApp(write);

    await (await app.request("/api/public/small")).text();
    await (await app.request("/not-api")).text();

    expect(write).not.toHaveBeenCalled();
  });

  it("does not fail the response when the log sink throws", async () => {
    const response = await makeApp(() => {
      throw new Error("sink unavailable");
    }).request("/api/public/big");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1234567890!");
  });
});
