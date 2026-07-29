/**
 * Auth middleware integration tests (against the seeded test API key).
 */
import { describe, expect, it } from "vitest";
import { apiGet, basicAuth } from "./helpers";
import { TEST_PUBLIC_KEY } from "./test-db-paths";

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

  it("serves the health endpoint without authentication", async () => {
    const res = await apiGet("/api/public/health", null);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OK");
  });
});
