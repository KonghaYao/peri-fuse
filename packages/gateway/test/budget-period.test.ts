import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiKey, budget, provider } from "../src/db/schema.js";
import { getDb } from "../src/db.js";
import { nextBudgetResetAt, parseBudgetPeriod } from "../src/spend/budget-period.js";
import { runBudgetReset } from "../src/spend/budget-reset.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
} from "./helpers/admin-test-harness.js";

describe("Gateway budget periods", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("parses supported periods and computes a deterministic next reset", () => {
    expect(parseBudgetPeriod("15m")).toBe(900_000);
    expect(parseBudgetPeriod("2h")).toBe(7_200_000);
    expect(parseBudgetPeriod("3d")).toBe(259_200_000);

    expect(nextBudgetResetAt("2h", new Date("2026-08-29T00:00:00.000Z"))).toBe(
      "2026-08-29T02:00:00.000Z",
    );

    for (const invalid of ["0d", "", "weekly", "1D", -1, null, "999999999999999999999999999999d"]) {
      expect(parseBudgetPeriod(invalid), String(invalid)).toBeNull();
    }
  });

  it("rejects creating a budget with a zero or unrepresentable period", async () => {
    const auditBefore = (await harness.request("A", "GET", "/admin/audit")).body.total;

    const response = await harness.request("A", "POST", "/admin/budgets", {
      maxBudget: 10,
      duration: "0d",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe(
      "Budget duration must be a positive integer followed by m, h, or d",
    );
    const overflow = await harness.request("A", "POST", "/admin/budgets", {
      maxBudget: 10,
      duration: "100000000d",
    });
    expect(overflow.status).toBe(400);
    expect((await harness.request("A", "GET", "/admin/budgets")).body.data).toEqual([]);
    expect((await harness.request("A", "GET", "/admin/audit")).body.total).toBe(auditBefore);
  });

  it("keeps a budget unchanged when an update period is invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));

    try {
      const created = await harness.request("A", "POST", "/admin/budgets", {
        maxBudget: 20,
        duration: "15m",
      });
      expect(created.body.resetAt).toBe("2026-08-29T00:15:00.000Z");
      const auditBefore = (await harness.request("A", "GET", "/admin/audit")).body.total;

      const invalid = await harness.request("A", "PUT", `/admin/budgets/${created.body.id}`, {
        duration: "forever",
      });
      const overflow = await harness.request("A", "PUT", `/admin/budgets/${created.body.id}`, {
        duration: "100000000d",
      });
      const unchanged = await harness.request("A", "GET", `/admin/budgets/${created.body.id}`);

      expect(invalid.status).toBe(400);
      expect(overflow.status).toBe(400);
      expect(unchanged.body.duration).toBe("15m");
      expect(unchanged.body.resetAt).toBe("2026-08-29T00:15:00.000Z");
      expect((await harness.request("A", "GET", "/admin/audit")).body.total).toBe(auditBefore);

      const valid = await harness.request("A", "PUT", `/admin/budgets/${created.body.id}`, {
        duration: "2h",
      });
      expect(valid.body.resetAt).toBe("2026-08-29T02:00:00.000Z");

      const disabled = await harness.request("A", "PUT", `/admin/budgets/${created.body.id}`, {
        duration: null,
      });
      expect(disabled.body.duration).toBeNull();
      expect(disabled.body.resetAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates provider periods without corrupting an existing provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));

    try {
      const auditBeforeCreate = (await harness.request("A", "GET", "/admin/audit")).body.total;
      const invalidCreate = await harness.request("A", "POST", "/admin/providers", {
        name: "invalid-period-provider",
        type: "openai",
        baseUrl: "https://invalid.example.com",
        budgetPeriod: "0d",
      });

      expect(invalidCreate.status).toBe(400);
      expect(invalidCreate.body.error.message).toBe(
        "Provider budget period must be a positive integer followed by m, h, or d",
      );
      const overflowCreate = await harness.request("A", "POST", "/admin/providers", {
        name: "overflow-period-provider",
        type: "openai",
        baseUrl: "https://overflow.example.com",
        budgetPeriod: "100000000d",
      });
      expect(overflowCreate.status).toBe(400);
      expect(
        (await harness.request("A", "GET", "/admin/providers")).body.data.some(
          (item: { name: string }) =>
            item.name === "invalid-period-provider" || item.name === "overflow-period-provider",
        ),
      ).toBe(false);
      expect((await harness.request("A", "GET", "/admin/audit")).body.total).toBe(
        auditBeforeCreate,
      );

      const created = await harness.request("A", "POST", "/admin/providers", {
        name: "period-provider",
        type: "openai",
        baseUrl: "https://provider.example.com",
        budgetPeriod: "1d",
      });
      expect(created.body.budgetResetAt).toBe("2026-08-30T00:00:00.000Z");
      const auditBeforeUpdate = (await harness.request("A", "GET", "/admin/audit")).body.total;

      const invalidUpdate = await harness.request(
        "A",
        "PUT",
        `/admin/providers/${created.body.id}`,
        { budgetPeriod: "forever" },
      );
      const overflowUpdate = await harness.request(
        "A",
        "PUT",
        `/admin/providers/${created.body.id}`,
        { budgetPeriod: "100000000d" },
      );
      const unchanged = await harness.request("A", "GET", `/admin/providers/${created.body.id}`);
      expect(invalidUpdate.status).toBe(400);
      expect(overflowUpdate.status).toBe(400);
      expect(unchanged.body.budgetPeriod).toBe("1d");
      expect(unchanged.body.budgetResetAt).toBe("2026-08-30T00:00:00.000Z");
      expect((await harness.request("A", "GET", "/admin/audit")).body.total).toBe(
        auditBeforeUpdate,
      );

      const ordinaryUpdate = await harness.request(
        "A",
        "PUT",
        `/admin/providers/${created.body.id}`,
        { name: "period-provider-renamed" },
      );
      expect(ordinaryUpdate.body.budgetResetAt).toBe("2026-08-30T00:00:00.000Z");

      const disabled = await harness.request("A", "PUT", `/admin/providers/${created.body.id}`, {
        budgetPeriod: null,
      });
      expect(disabled.body.budgetPeriod).toBeNull();
      expect(disabled.body.budgetResetAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables historical invalid periods once without logging their values", async () => {
    const db = getDb();
    const invalidPeriod = "legacy-value-must-not-be-logged";
    await db.insert(budget).values({
      id: "historical-invalid-budget",
      projectId: "project-admin-a",
      maxBudget: 10,
      duration: invalidPeriod,
      resetAt: "2099-01-01T00:00:00.000Z",
    });
    await db.insert(provider).values({
      id: "historical-invalid-provider",
      projectId: "project-admin-a",
      name: "historical-invalid-provider",
      type: "openai",
      baseUrl: "https://historical.example.com",
      budgetLimit: 10,
      budgetSpend: 7,
      budgetPeriod: invalidPeriod,
      budgetResetAt: "2099-01-01T00:00:00.000Z",
      apiKeyEncrypted: "encrypted-secret-must-not-be-logged",
    });
    const auditBefore = (await harness.request("A", "GET", "/admin/audit")).body.total;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await runBudgetReset(new Date("2026-08-29T00:00:00.000Z"));

      const healedBudget = await db.query.budget.findFirst({
        where: eq(budget.id, "historical-invalid-budget"),
      });
      const healedProvider = await db.query.provider.findFirst({
        where: eq(provider.id, "historical-invalid-provider"),
      });
      expect(healedBudget?.duration).toBeNull();
      expect(healedBudget?.resetAt).toBeNull();
      expect(healedProvider?.budgetPeriod).toBeNull();
      expect(healedProvider?.budgetResetAt).toBeNull();
      expect(healedProvider?.budgetSpend).toBe(7);
      expect(warn).toHaveBeenCalledTimes(2);

      const warnings = warn.mock.calls.flat().join(" ");
      expect(warnings).not.toContain(invalidPeriod);
      expect(warnings).not.toContain("encrypted-secret-must-not-be-logged");
      expect((await harness.request("A", "GET", "/admin/audit")).body.total).toBe(auditBefore);

      await runBudgetReset(new Date("2026-08-29T00:01:00.000Z"));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("disables periods whose next reset cannot be represented by JavaScript Date", async () => {
    const db = getDb();
    const overflowPeriod = "100000000d";
    expect(parseBudgetPeriod(overflowPeriod)).not.toBeNull();
    await db.insert(budget).values({
      id: "historical-overflow-budget",
      projectId: PROJECT_A,
      maxBudget: 10,
      duration: overflowPeriod,
      resetAt: "2026-08-28T23:59:00.000Z",
    });
    await db.insert(apiKey).values({
      id: "historical-overflow-key",
      projectId: PROJECT_A,
      publicKey: "pk-historical-overflow",
      spend: 4,
      budgetId: "historical-overflow-budget",
    });
    await db.insert(provider).values({
      id: "historical-overflow-provider",
      projectId: PROJECT_A,
      name: "historical-overflow-provider",
      type: "openai",
      baseUrl: "https://overflow.example.com",
      budgetLimit: 10,
      budgetSpend: 3,
      budgetPeriod: overflowPeriod,
      budgetResetAt: "2026-08-28T23:59:00.000Z",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await runBudgetReset(new Date("2026-08-29T00:00:00.000Z"));

      const healedBudget = await db.query.budget.findFirst({
        where: eq(budget.id, "historical-overflow-budget"),
      });
      const unchangedKey = await db.query.apiKey.findFirst({
        where: eq(apiKey.id, "historical-overflow-key"),
      });
      const healedProvider = await db.query.provider.findFirst({
        where: eq(provider.id, "historical-overflow-provider"),
      });
      expect(healedBudget?.duration).toBeNull();
      expect(healedBudget?.resetAt).toBeNull();
      expect(unchangedKey?.spend).toBe(4);
      expect(healedProvider?.budgetPeriod).toBeNull();
      expect(healedProvider?.budgetResetAt).toBeNull();
      expect(healedProvider?.budgetSpend).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(overflowPeriod);

      await runBudgetReset(new Date("2026-08-29T00:01:00.000Z"));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("resets due spend at a deterministic time without crossing project boundaries", async () => {
    const db = getDb();
    await db.insert(budget).values({
      id: "due-period-budget",
      projectId: PROJECT_A,
      maxBudget: 10,
      duration: "1h",
      resetAt: "2026-08-28T23:59:00.000Z",
    });
    await db.insert(apiKey).values([
      {
        id: "due-period-key-a",
        projectId: PROJECT_A,
        publicKey: "pk-due-period-a",
        spend: 8,
        budgetId: "due-period-budget",
      },
      {
        id: "legacy-foreign-period-key-b",
        projectId: PROJECT_B,
        publicKey: "pk-due-period-b",
        spend: 9,
        budgetId: "due-period-budget",
      },
    ]);
    await db.insert(provider).values({
      id: "due-period-provider",
      projectId: PROJECT_A,
      name: "due-period-provider",
      type: "openai",
      baseUrl: "https://due.example.com",
      budgetLimit: 10,
      budgetSpend: 6,
      budgetPeriod: "30m",
      budgetResetAt: "2026-08-28T23:59:00.000Z",
    });

    await runBudgetReset(new Date("2026-08-29T00:00:00.000Z"));

    const keyA = await db.query.apiKey.findFirst({ where: eq(apiKey.id, "due-period-key-a") });
    const keyB = await db.query.apiKey.findFirst({
      where: eq(apiKey.id, "legacy-foreign-period-key-b"),
    });
    const resetBudget = await db.query.budget.findFirst({
      where: eq(budget.id, "due-period-budget"),
    });
    const resetProvider = await db.query.provider.findFirst({
      where: eq(provider.id, "due-period-provider"),
    });

    expect(keyA?.spend).toBe(0);
    expect(keyB?.spend).toBe(9);
    expect(resetBudget?.resetAt).toBe("2026-08-29T01:00:00.000Z");
    expect(resetProvider?.budgetSpend).toBe(0);
    expect(resetProvider?.budgetResetAt).toBe("2026-08-29T00:30:00.000Z");
  });

  it("rolls back key spend when advancing a due budget reset fails", async () => {
    const db = getDb();
    await db.insert(budget).values({
      id: "atomic-period-budget",
      projectId: PROJECT_A,
      maxBudget: 10,
      duration: "1h",
      resetAt: "2026-08-28T23:59:00.000Z",
    });
    await db.insert(apiKey).values({
      id: "atomic-period-key",
      projectId: PROJECT_A,
      publicKey: "pk-atomic-period",
      spend: 5,
      budgetId: "atomic-period-budget",
    });
    db.run(
      sql.raw(`
      CREATE TRIGGER fail_atomic_budget_reset
      BEFORE UPDATE OF resetAt ON Budget
      WHEN OLD.id = 'atomic-period-budget'
      BEGIN
        SELECT RAISE(ABORT, 'forced reset failure');
      END
    `),
    );

    try {
      await expect(runBudgetReset(new Date("2026-08-29T00:00:00.000Z"))).rejects.toThrow(
        "forced reset failure",
      );
      const key = await db.query.apiKey.findFirst({
        where: eq(apiKey.id, "atomic-period-key"),
      });
      const unchangedBudget = await db.query.budget.findFirst({
        where: eq(budget.id, "atomic-period-budget"),
      });
      expect(key?.spend).toBe(5);
      expect(unchangedBudget?.resetAt).toBe("2026-08-28T23:59:00.000Z");
    } finally {
      db.run(sql.raw("DROP TRIGGER IF EXISTS fail_atomic_budget_reset"));
    }
  });
});
