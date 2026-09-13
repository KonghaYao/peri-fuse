import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayEnv } from "../src/app.js";
import { unifiedAuth } from "../src/middleware/auth.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
  PUBLIC_KEY_A,
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

  it("rejects a Basic public key from another project after the secret was cached", async () => {
    const probe = new Hono<GatewayEnv>();
    probe.use("/probe", unifiedAuth);
    probe.get("/probe", (c) => c.json({ projectId: c.get("projectId") }));
    expect(
      (
        await probe.request("/probe", {
          headers: { Authorization: `Bearer ${SECRET_KEY_B}` },
        })
      ).status,
    ).toBe(200);
    const response = await probe.request("/probe", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${PUBLIC_KEY_A}:${SECRET_KEY_B}`).toString("base64")}`,
      },
    });
    expect(response.status).toBe(401);
    const valid = await probe.request("/probe", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${PUBLIC_KEY_B}:${SECRET_KEY_B}`).toString("base64")}`,
      },
    });
    expect(await valid.json()).toEqual({ projectId: PROJECT_B });
  });
});
