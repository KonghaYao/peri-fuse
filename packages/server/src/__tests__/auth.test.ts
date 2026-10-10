/**
 * Auth middleware integration tests (against the seeded test API key).
 */

import { prisma } from "@peri-fuse/shared/src/db";
import { apiKeys, organizations, projects } from "@peri-fuse/shared/src/db/schema/index.js";
import { createShaHash, hashSecretKey } from "@peri-fuse/shared/src/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { verifyAuthHeader } from "../auth";
import { apiGet, basicAuth } from "./helpers";
import { TEST_ORG_ID, TEST_PROJECT_ID, TEST_PUBLIC_KEY, TEST_SALT } from "./test-db-paths";

describe("lite-server auth middleware", () => {
  it("returns 401 when the Authorization header is missing", async () => {
    const res = await apiGet("/api/public/traces", null);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("No authorization header");
  });

  it("returns 401 for a non-Basic authorization scheme", async () => {
    const res = await apiGet("/api/public/traces", "Bearer some-token");
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Invalid authorization header");
  });

  it("returns 401 for an unknown public key", async () => {
    const res = await apiGet("/api/public/traces", basicAuth("pk-lf-does-not-exist", "sk-lf-nope"));
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Invalid credentials");
  });

  it("returns 401 for a wrong secret key", async () => {
    const res = await apiGet(
      "/api/public/traces",
      basicAuth(TEST_PUBLIC_KEY, "sk-lf-wrong-secret"),
    );
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Invalid credentials");
  });

  it("accepts valid credentials and returns the traces envelope", async () => {
    const res = await apiGet("/api/public/traces?limit=1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta).toHaveProperty("page");
    expect(res.body.meta).toHaveProperty("limit");
    expect(res.body.meta).toHaveProperty("totalItems");
    expect(res.body.meta).toHaveProperty("totalPages");
  });

  it("observes API key revocation on the next request", async () => {
    const id = crypto.randomUUID();
    const publicKey = `pk-lf-revoke-${id}`;
    const secretKey = `sk-lf-revoke-${id}`;
    await prisma.insert(apiKeys).values({
      id,
      publicKey,
      hashedSecretKey: await hashSecretKey(secretKey),
      fastHashedSecretKey: createShaHash(secretKey, TEST_SALT),
      displaySecretKey: "test",
      projectId: TEST_PROJECT_ID,
      organizationId: TEST_ORG_ID,
      scope: "PROJECT",
    });
    try {
      expect((await verifyAuthHeader(basicAuth(publicKey, secretKey))).validKey).toBe(true);
      await prisma.delete(apiKeys).where(eq(apiKeys.id, id));
      expect((await verifyAuthHeader(basicAuth(publicKey, secretKey))).validKey).toBe(false);
    } finally {
      await prisma.delete(apiKeys).where(eq(apiKeys.id, id));
    }
  });

  it("returns independent rate limits and observes organization config changes", async () => {
    const id = crypto.randomUUID();
    const orgId = `org-${id}`;
    const projectId = `project-${id}`;
    const publicKey = `pk-lf-config-${id}`;
    const secretKey = `sk-lf-config-${id}`;
    await prisma.insert(organizations).values({
      id: orgId,
      name: "Rate limit cache test",
      cloudConfig: JSON.stringify({
        rateLimitOverrides: [{ resource: "ingestion", points: 10, durationInSec: 60 }],
      }),
    });
    await prisma.insert(projects).values({ id: projectId, orgId, name: "Rate limit cache test" });
    await prisma.insert(apiKeys).values({
      id,
      publicKey,
      hashedSecretKey: await hashSecretKey(secretKey),
      fastHashedSecretKey: createShaHash(secretKey, TEST_SALT),
      displaySecretKey: "test",
      projectId,
      organizationId: orgId,
      scope: "PROJECT",
    });
    try {
      const header = basicAuth(publicKey, secretKey);
      const first = await verifyAuthHeader(header);
      expect(first.validKey).toBe(true);
      if (!first.validKey) throw new Error("Expected valid key");
      first.scope.rateLimitOverrides[0].points = 999;
      first.scope.rateLimitOverrides.push({ resource: "prompts", points: 1 });
      const second = await verifyAuthHeader(header);
      expect(second.validKey).toBe(true);
      if (!second.validKey) throw new Error("Expected valid key");
      expect(second.scope.rateLimitOverrides).toEqual([
        { resource: "ingestion", points: 10, durationInSec: 60 },
      ]);
      await prisma
        .update(organizations)
        .set({
          cloudConfig: JSON.stringify({
            rateLimitOverrides: [{ resource: "ingestion", points: 20 }],
          }),
        })
        .where(eq(organizations.id, orgId));
      const updated = await verifyAuthHeader(header);
      expect(updated.validKey).toBe(true);
      if (!updated.validKey) throw new Error("Expected valid key");
      expect(updated.scope.rateLimitOverrides[0].points).toBe(20);
    } finally {
      await prisma.delete(apiKeys).where(eq(apiKeys.id, id));
      await prisma.delete(projects).where(eq(projects.id, projectId));
      await prisma.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  it("serves the health endpoint without authentication", async () => {
    const res = await apiGet("/api/public/health", null);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OK");
  });
});
