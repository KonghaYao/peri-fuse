import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PUBLIC_KEY_A,
  PUBLIC_KEY_B,
} from "./helpers/admin-test-harness.js";

async function auditCount(harness: AdminTestHarness, project: "A" | "B"): Promise<number> {
  return (await harness.request(project, "GET", "/admin/audit")).body.total;
}

describe("Gateway Admin project-owned references", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("rejects creating a model with a provider from another project", async () => {
    const providerB = await harness.request("B", "POST", "/admin/providers", {
      name: "provider-b-for-model-create",
      type: "openai",
      baseUrl: "https://b.example.com",
    });
    const beforeAudit = await auditCount(harness, "A");

    const create = await harness.request("A", "POST", "/admin/models", {
      modelName: "model-with-foreign-provider",
      providerId: providerB.body.id,
      providerModel: "provider-model-b",
    });
    const modelsA = await harness.request("A", "GET", "/admin/models");

    expect(create.status).toBe(404);
    expect(
      modelsA.body.data.some(
        (item: { modelName: string }) => item.modelName === "model-with-foreign-provider",
      ),
    ).toBe(false);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects moving a model to a provider from another project", async () => {
    const providerA = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-a",
      type: "openai",
      baseUrl: "https://a.example.com",
    });
    const providerB = await harness.request("B", "POST", "/admin/providers", {
      name: "provider-b",
      type: "openai",
      baseUrl: "https://b.example.com",
    });
    const modelA = await harness.request("A", "POST", "/admin/models", {
      modelName: "model-a",
      providerId: providerA.body.id,
      providerModel: "provider-model-a",
    });
    const beforeAudit = await auditCount(harness, "A");

    const update = await harness.request("A", "PUT", `/admin/models/${modelA.body.id}`, {
      providerId: providerB.body.id,
    });
    const reread = await harness.request("A", "GET", `/admin/models/${modelA.body.id}`);

    expect(update.status).toBe(404);
    expect(reread.body.providerId).toBe(providerA.body.id);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects creating a provider with a credential from another project", async () => {
    const credentialB = await harness.request("B", "POST", "/admin/credentials", {
      name: "credential-b-for-create",
      values: { apiKey: "secret-b" },
    });
    const beforeAudit = await auditCount(harness, "A");

    const create = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-with-foreign-credential",
      type: "openai",
      baseUrl: "https://a.example.com",
      credentialId: credentialB.body.id,
    });
    const providersA = await harness.request("A", "GET", "/admin/providers");

    expect(create.status).toBe(404);
    expect(
      providersA.body.data.some(
        (item: { name: string }) => item.name === "provider-with-foreign-credential",
      ),
    ).toBe(false);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects moving a provider to a credential from another project", async () => {
    const credentialA = await harness.request("A", "POST", "/admin/credentials", {
      name: "credential-a-for-update",
      values: { apiKey: "secret-a" },
    });
    const credentialB = await harness.request("B", "POST", "/admin/credentials", {
      name: "credential-b-for-update",
      values: { apiKey: "secret-b" },
    });
    const providerA = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-a-with-credential",
      type: "openai",
      baseUrl: "https://a.example.com",
      credentialId: credentialA.body.id,
    });
    const beforeAudit = await auditCount(harness, "A");

    const update = await harness.request("A", "PUT", `/admin/providers/${providerA.body.id}`, {
      credentialId: credentialB.body.id,
    });
    const reread = await harness.request("A", "GET", `/admin/providers/${providerA.body.id}`);

    expect(update.status).toBe(404);
    expect(reread.body.credentialId).toBe(credentialA.body.id);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects creating a key config with a budget from another project", async () => {
    const budgetB = await harness.request("B", "POST", "/admin/budgets", {
      maxBudget: 20,
    });
    const beforeAudit = await auditCount(harness, "A");

    const create = await harness.request("A", "POST", "/admin/keys", {
      publicKey: PUBLIC_KEY_A,
      keyName: "key-with-foreign-budget",
      budgetId: budgetB.body.id,
    });
    const keysA = await harness.request("A", "GET", "/admin/keys");

    expect(create.status).toBe(404);
    expect(
      keysA.body.data.some(
        (item: { keyName: string }) => item.keyName === "key-with-foreign-budget",
      ),
    ).toBe(false);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects moving a key config to a budget from another project", async () => {
    const budgetA = await harness.request("A", "POST", "/admin/budgets", {
      maxBudget: 10,
    });
    const budgetB = await harness.request("B", "POST", "/admin/budgets", {
      maxBudget: 20,
    });
    const keyA = await harness.request("A", "POST", "/admin/keys", {
      publicKey: PUBLIC_KEY_A,
      keyName: "key-a-for-budget-update",
      budgetId: budgetA.body.id,
    });
    const beforeAudit = await auditCount(harness, "A");

    const update = await harness.request("A", "PUT", `/admin/keys/${keyA.body.id}`, {
      budgetId: budgetB.body.id,
    });
    const reread = await harness.request("A", "GET", `/admin/keys/${keyA.body.id}`);

    expect(update.status).toBe(404);
    expect(reread.body.budgetId).toBe(budgetA.body.id);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects creating a key config for another project's public key", async () => {
    const beforeAudit = await auditCount(harness, "A");
    const create = await harness.request("A", "POST", "/admin/keys", {
      publicKey: PUBLIC_KEY_B,
      keyName: "foreign-public-key",
    });
    const keysA = await harness.request("A", "GET", "/admin/keys");

    expect(create.status).toBe(404);
    expect(
      keysA.body.data.some((item: { keyName: string }) => item.keyName === "foreign-public-key"),
    ).toBe(false);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("returns the same 404 for a public key that does not exist", async () => {
    const beforeAudit = await auditCount(harness, "A");
    const create = await harness.request("A", "POST", "/admin/keys", {
      publicKey: "pk-does-not-exist",
      keyName: "missing-public-key",
    });

    expect(create.status).toBe(404);
    expect(create.body.error.message).toBe("Project API key not found");
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rejects mutating a legacy key config whose public key belongs to another project", async () => {
    const keyId = await harness.seedGatewayKeyConfig("project-admin-a", PUBLIC_KEY_B);
    const beforeAudit = await auditCount(harness, "A");

    const update = await harness.request("A", "PUT", `/admin/keys/${keyId}`, {
      keyName: "must-not-change",
    });
    const remove = await harness.request("A", "DELETE", `/admin/keys/${keyId}`);
    const reread = await harness.request("A", "GET", `/admin/keys/${keyId}`);

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(reread.body.keyName).toBeNull();
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });
});
