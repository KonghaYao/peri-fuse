import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
  PUBLIC_KEY_A,
  PUBLIC_KEY_B,
} from "./helpers/admin-test-harness.js";

async function auditCount(harness: AdminTestHarness, project: "A" | "B"): Promise<number> {
  return (await harness.request(project, "GET", "/admin/audit")).body.total;
}

describe("Gateway Admin project-scoped mutations", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("prevents another project from updating or deleting every Admin resource", async () => {
    const credential = await harness.request("A", "POST", "/admin/credentials", {
      name: "credential-owned-by-a",
      values: { apiKey: "secret-a" },
    });
    const provider = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-owned-by-a",
      type: "openai",
      baseUrl: "https://a.example.com",
      credentialId: credential.body.id,
    });
    const model = await harness.request("A", "POST", "/admin/models", {
      modelName: "model-owned-by-a",
      providerId: provider.body.id,
      providerModel: "provider-model-a",
    });
    const budget = await harness.request("A", "POST", "/admin/budgets", {
      maxBudget: 10,
    });
    const key = await harness.request("A", "POST", "/admin/keys", {
      publicKey: PUBLIC_KEY_A,
      keyName: "key-owned-by-a",
      budgetId: budget.body.id,
    });
    const beforeAuditA = await auditCount(harness, "A");
    const beforeAuditB = await auditCount(harness, "B");

    const resources = [
      { path: `/admin/credentials/${credential.body.id}`, update: { name: "stolen" } },
      { path: `/admin/providers/${provider.body.id}`, update: { name: "stolen" } },
      { path: `/admin/models/${model.body.id}`, update: { modelName: "stolen" } },
      { path: `/admin/budgets/${budget.body.id}`, update: { maxBudget: 999 } },
      { path: `/admin/keys/${key.body.id}`, update: { keyName: "stolen" } },
    ];

    for (const resource of resources) {
      const update = await harness.request("B", "PUT", resource.path, resource.update);
      const remove = await harness.request("B", "DELETE", resource.path);
      expect(update.status, resource.path).toBe(404);
      expect(remove.status, resource.path).toBe(404);
    }

    expect((await harness.request("A", "GET", `/admin/providers/${provider.body.id}`)).status).toBe(
      200,
    );
    expect((await harness.request("A", "GET", `/admin/models/${model.body.id}`)).status).toBe(200);
    expect((await harness.request("A", "GET", `/admin/budgets/${budget.body.id}`)).status).toBe(
      200,
    );
    expect((await harness.request("A", "GET", `/admin/keys/${key.body.id}`)).status).toBe(200);
    const credentials = await harness.request("A", "GET", "/admin/credentials");
    expect(
      credentials.body.data.some((item: { id: string }) => item.id === credential.body.id),
    ).toBe(true);
    expect(
      credentials.body.data.find((item: { id: string }) => item.id === credential.body.id).name,
    ).toBe("credential-owned-by-a");
    expect(
      (await harness.request("A", "GET", `/admin/providers/${provider.body.id}`)).body.name,
    ).toBe("provider-owned-by-a");
    expect(
      (await harness.request("A", "GET", `/admin/models/${model.body.id}`)).body.modelName,
    ).toBe("model-owned-by-a");
    expect(
      (await harness.request("A", "GET", `/admin/models/${model.body.id}`)).body.provider.id,
    ).toBe(provider.body.id);
    expect(
      (await harness.request("A", "GET", `/admin/budgets/${budget.body.id}`)).body.maxBudget,
    ).toBe(10);
    expect(
      (await harness.request("A", "GET", `/admin/budgets/${budget.body.id}`)).body.keys.map(
        (item: { id: string }) => item.id,
      ),
    ).toContain(key.body.id);
    expect((await harness.request("A", "GET", `/admin/keys/${key.body.id}`)).body.keyName).toBe(
      "key-owned-by-a",
    );
    expect((await harness.request("A", "GET", `/admin/keys/${key.body.id}`)).body.budget.id).toBe(
      budget.body.id,
    );
    expect(await auditCount(harness, "A")).toBe(beforeAuditA);
    expect(await auditCount(harness, "B")).toBe(beforeAuditB);

    expect(
      (
        await harness.request("A", "PUT", `/admin/models/${model.body.id}`, {
          modelName: "model-updated-by-a",
        })
      ).status,
    ).toBe(200);
    expect((await harness.request("A", "DELETE", `/admin/models/${model.body.id}`)).status).toBe(
      200,
    );
    expect((await harness.request("A", "DELETE", `/admin/keys/${key.body.id}`)).status).toBe(200);
    expect(
      (await harness.request("A", "DELETE", `/admin/providers/${provider.body.id}`)).status,
    ).toBe(200);
    expect(
      (await harness.request("A", "DELETE", `/admin/credentials/${credential.body.id}`)).status,
    ).toBe(200);
    expect((await harness.request("A", "DELETE", `/admin/budgets/${budget.body.id}`)).status).toBe(
      200,
    );
  });

  it("does not preload a provider from another project into model responses", async () => {
    const providerB = await harness.request("B", "POST", "/admin/providers", {
      name: "provider-b-for-foreign-model-read",
      type: "openai",
      baseUrl: "https://b.example.com",
      apiKey: "must-not-leak-to-project-a",
    });
    await harness.seedModelDeployment(
      "model-a-with-foreign-provider",
      PROJECT_A,
      providerB.body.id,
      "model-a-with-foreign-provider",
    );

    const list = await harness.request("A", "GET", "/admin/models");
    const detail = await harness.request("A", "GET", "/admin/models/model-a-with-foreign-provider");
    const listedModel = list.body.data.find(
      (item: { id: string }) => item.id === "model-a-with-foreign-provider",
    );

    expect(JSON.stringify({ list: list.body, detail: detail.body })).not.toContain(
      "apiKeyEncrypted",
    );
    expect(listedModel.provider).toBeNull();
    expect(detail.body.provider).toBeNull();
  });

  it("does not preload a budget from another project into key responses", async () => {
    const budgetB = await harness.request("B", "POST", "/admin/budgets", { maxBudget: 999 });
    await harness.seedBudgetKeyConfig(
      "key-a-with-foreign-budget",
      PROJECT_A,
      "pk-legacy-a-with-foreign-budget",
      budgetB.body.id,
    );

    const list = await harness.request("A", "GET", "/admin/keys");
    const detail = await harness.request("A", "GET", "/admin/keys/key-a-with-foreign-budget");
    const listedKey = list.body.data.find(
      (item: { id: string }) => item.id === "key-a-with-foreign-budget",
    );

    expect(listedKey.budget).toBeNull();
    expect(detail.body.budget).toBeNull();
  });

  it("does not count or preload another project's key into budget responses", async () => {
    const budgetA = await harness.request("A", "POST", "/admin/budgets", { maxBudget: 30 });
    await harness.seedBudgetKeyConfig(
      "key-b-with-foreign-budget",
      PROJECT_B,
      "pk-legacy-b-with-foreign-budget",
      budgetA.body.id,
    );

    const list = await harness.request("A", "GET", "/admin/budgets");
    const detail = await harness.request("A", "GET", `/admin/budgets/${budgetA.body.id}`);
    const listedBudget = list.body.data.find((item: { id: string }) => item.id === budgetA.body.id);

    expect(listedBudget.keyCount).toBe(0);
    expect(detail.body.keys).toEqual([]);
  });

  it("keeps provider deployments scoped in relation responses and counts", async () => {
    const providerA = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-a-for-relation",
      type: "openai",
      baseUrl: "https://a.example.com",
    });
    const modelA = await harness.request("A", "POST", "/admin/models", {
      modelName: "model-a-for-relation",
      providerId: providerA.body.id,
      providerModel: "provider-model-a",
    });
    await harness.seedModelDeployment(
      "foreign-model-for-relation",
      PROJECT_B,
      providerA.body.id,
      "model-b-for-relation",
    );

    const list = await harness.request("A", "GET", "/admin/providers");
    const reread = await harness.request("A", "GET", `/admin/providers/${providerA.body.id}`);
    const listedProvider = list.body.data.find(
      (item: { id: string }) => item.id === providerA.body.id,
    );

    expect(listedProvider.deploymentCount).toBe(1);
    expect(reread.body.deployments.map((item: { id: string }) => item.id)).toEqual([
      modelA.body.id,
    ]);
  });

  it("rolls back provider deletion when a foreign-project deployment blocks it", async () => {
    const providerA = await harness.request("A", "POST", "/admin/providers", {
      name: "provider-a-for-blocked-cascade",
      type: "openai",
      baseUrl: "https://a.example.com",
    });
    const modelA = await harness.request("A", "POST", "/admin/models", {
      modelName: "model-a-for-blocked-cascade",
      providerId: providerA.body.id,
      providerModel: "provider-model-a",
    });
    await harness.seedModelDeployment(
      "foreign-model-blocking-provider-delete",
      PROJECT_B,
      providerA.body.id,
      "model-b-blocking-provider-delete",
    );
    const beforeAudit = await auditCount(harness, "A");

    const remove = await harness.request("A", "DELETE", `/admin/providers/${providerA.body.id}`);

    expect(remove.status).toBe(409);
    expect(remove.body.error.message).toBe(
      "Provider cannot be deleted while deployments reference it",
    );
    expect(
      (await harness.request("A", "GET", `/admin/providers/${providerA.body.id}`)).status,
    ).toBe(200);
    expect((await harness.request("A", "GET", `/admin/models/${modelA.body.id}`)).status).toBe(200);
    expect(
      (await harness.request("B", "GET", "/admin/models/foreign-model-blocking-provider-delete"))
        .status,
    ).toBe(200);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("rolls back budget deletion when a foreign-project key blocks it", async () => {
    const budgetA = await harness.request("A", "POST", "/admin/budgets", { maxBudget: 10 });
    const keyA = await harness.request("A", "POST", "/admin/keys", {
      publicKey: PUBLIC_KEY_A,
      budgetId: budgetA.body.id,
    });
    await harness.seedBudgetKeyConfig(
      "foreign-key-blocking-budget-delete",
      PROJECT_B,
      "pk-legacy-foreign-budget-reference",
      budgetA.body.id,
    );
    const beforeAudit = await auditCount(harness, "A");

    const remove = await harness.request("A", "DELETE", `/admin/budgets/${budgetA.body.id}`);

    expect(remove.status).toBe(409);
    expect(remove.body.error.message).toBe("Budget cannot be deleted while API keys reference it");
    expect((await harness.request("A", "GET", `/admin/budgets/${budgetA.body.id}`)).status).toBe(
      200,
    );
    expect((await harness.request("A", "GET", `/admin/keys/${keyA.body.id}`)).body.budgetId).toBe(
      budgetA.body.id,
    );
    expect(
      (await harness.request("B", "GET", "/admin/keys/foreign-key-blocking-budget-delete")).body
        .budgetId,
    ).toBe(budgetA.body.id);
    expect(await auditCount(harness, "A")).toBe(beforeAudit);
  });

  it("keeps successful same-project provider and budget cascades", async () => {
    const providerB = await harness.request("B", "POST", "/admin/providers", {
      name: "provider-b-for-cascade",
      type: "openai",
      baseUrl: "https://b.example.com",
    });
    const modelB = await harness.request("B", "POST", "/admin/models", {
      modelName: "model-b-for-cascade",
      providerId: providerB.body.id,
      providerModel: "provider-model-b",
    });
    const budgetB = await harness.request("B", "POST", "/admin/budgets", { maxBudget: 10 });
    const keyB = await harness.request("B", "POST", "/admin/keys", {
      publicKey: PUBLIC_KEY_B,
      budgetId: budgetB.body.id,
    });

    expect(
      (await harness.request("B", "DELETE", `/admin/providers/${providerB.body.id}`)).status,
    ).toBe(200);
    expect((await harness.request("B", "GET", `/admin/models/${modelB.body.id}`)).status).toBe(404);

    expect((await harness.request("B", "DELETE", `/admin/budgets/${budgetB.body.id}`)).status).toBe(
      200,
    );
    const rereadKeyB = await harness.request("B", "GET", `/admin/keys/${keyB.body.id}`);
    expect(rereadKeyB.body.budgetId).toBeNull();
  });
});
