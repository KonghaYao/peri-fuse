import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminTestHarness, createAdminTestHarness } from "./helpers/admin-test-harness.js";

describe("Gateway Admin provider secret responses", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("redacts an API key from the create response and audit log", async () => {
    const apiKey = "provider-create-secret";
    const created = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-create-redaction",
      type: "openai",
      baseUrl: "https://create.example.com",
      apiKey,
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "provider-create-redaction",
      type: "openai",
      baseUrl: "https://create.example.com",
      apiKeyEncrypted: "***encrypted***",
    });
    expect(JSON.stringify(created.body)).not.toContain(apiKey);

    const audit = await harness.request(
      "A",
      "GET",
      `/admin/audit?tableName=Provider&objectId=${created.body.id}`,
    );
    expect(audit.status).toBe(200);
    expect(audit.body.data[0].afterValue.apiKeyEncrypted).toBe("***");
    expect(JSON.stringify(audit.body)).not.toContain(apiKey);
  });

  it("returns null when a created provider has no API key", async () => {
    const created = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-without-secret",
      type: "openai",
      baseUrl: "https://no-secret.example.com",
    });

    expect(created.status).toBe(201);
    expect(created.body.apiKeyEncrypted).toBeNull();
  });

  it("keeps an existing API key redacted after an ordinary update", async () => {
    const apiKey = "provider-existing-secret";
    const created = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-before-ordinary-update",
      type: "openai",
      baseUrl: "https://ordinary-update.example.com",
      apiKey,
    });

    const updated = await harness.request("A", "PUT", `/admin/providers/${created.body.id}`, {
      name: "provider-after-ordinary-update",
    });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.body.id,
      name: "provider-after-ordinary-update",
      apiKeyEncrypted: "***encrypted***",
    });
    expect(JSON.stringify(updated.body)).not.toContain(apiKey);
  });

  it("redacts a newly supplied API key from the update response and audit log", async () => {
    const created = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-before-key-update",
      type: "openai",
      baseUrl: "https://key-update.example.com",
    });
    const apiKey = "provider-updated-secret";

    const updated = await harness.request("A", "PUT", `/admin/providers/${created.body.id}`, {
      apiKey,
    });

    expect(updated.status).toBe(200);
    expect(updated.body.apiKeyEncrypted).toBe("***encrypted***");
    expect(JSON.stringify(updated.body)).not.toContain(apiKey);

    const audit = await harness.request(
      "A",
      "GET",
      `/admin/audit?tableName=Provider&objectId=${created.body.id}&action=update`,
    );
    expect(audit.status).toBe(200);
    expect(audit.body.data[0].beforeValue.apiKeyEncrypted).toBe("***");
    expect(audit.body.data[0].afterValue.apiKeyEncrypted).toBe("***");
    expect(JSON.stringify(audit.body)).not.toContain(apiKey);
  });

  it("uses the same redaction while preserving list and detail relation shapes", async () => {
    const created = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-read-redaction",
      type: "openai",
      baseUrl: "https://read.example.com",
      apiKey: "provider-read-secret",
    });

    const list = await harness.request("A", "GET", "/admin/providers");
    const detail = await harness.request("A", "GET", `/admin/providers/${created.body.id}`);
    const listed = list.body.data.find((item: { id: string }) => item.id === created.body.id);

    expect(list.status).toBe(200);
    expect(listed.apiKeyEncrypted).toBe("***encrypted***");
    expect(listed.deploymentCount).toBe(0);
    expect(listed).not.toHaveProperty("deployments");
    expect(detail.status).toBe(200);
    expect(detail.body.apiKeyEncrypted).toBe("***encrypted***");
    expect(detail.body.deployments).toEqual([]);
  });
});
