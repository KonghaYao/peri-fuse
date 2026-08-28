import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayEnv } from "../src/app.js";
import { unifiedAuth } from "../src/middleware/auth.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
  PUBLIC_KEY_B,
  SECRET_KEY_B,
} from "./helpers/admin-test-harness.js";

describe("Gateway runtime key config project isolation", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("does not load a same-public-key config owned by another project", async () => {
    await harness.seedGatewayKeyConfig(PROJECT_A, PUBLIC_KEY_B);

    const probe = new Hono<GatewayEnv>();
    probe.use("/probe", unifiedAuth);
    probe.get("/probe", (c) => c.json({ configProjectId: c.get("apiKeyRecord").projectId }));
    const response = await probe.request("/probe", {
      headers: { Authorization: `Bearer ${SECRET_KEY_B}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configProjectId: PROJECT_B });
  });
});
