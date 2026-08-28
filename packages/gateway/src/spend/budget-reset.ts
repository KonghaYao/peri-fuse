/**
 * Budget reset scheduler.
 * Periodically checks and resets budgets whose duration has elapsed.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { apiKey, budget, provider } from "../db/schema.js";
import { getDb } from "../db.js";
import { nextBudgetResetAt } from "./budget-period.js";

let resetTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run one deterministic budget reset pass.
 * Invalid historical periods are disabled without logging their raw values.
 */
export async function runBudgetReset(now = new Date()): Promise<void> {
  const db = getDb();
  const nowIso = now.toISOString();

  const configuredBudgets = await db.select().from(budget).where(isNotNull(budget.duration));

  for (const b of configuredBudgets) {
    const nextReset = nextBudgetResetAt(b.duration!, now);
    if (nextReset === null) {
      db.update(budget)
        .set({ duration: null, resetAt: null })
        .where(and(eq(budget.id, b.id), eq(budget.projectId, b.projectId)))
        .run();
      console.warn(
        `[budget-reset] Disabled invalid Budget period for project ${b.projectId}, budget ${b.id}`,
      );
      continue;
    }
    if (!b.resetAt || b.resetAt > nowIso) continue;

    db.transaction((tx) => {
      tx.update(apiKey)
        .set({ spend: 0 })
        .where(and(eq(apiKey.budgetId, b.id), eq(apiKey.projectId, b.projectId)))
        .run();
      tx.update(budget)
        .set({ resetAt: nextReset })
        .where(and(eq(budget.id, b.id), eq(budget.projectId, b.projectId)))
        .run();
    });
  }

  const configuredProviders = await db
    .select()
    .from(provider)
    .where(isNotNull(provider.budgetPeriod));

  for (const p of configuredProviders) {
    const nextReset = nextBudgetResetAt(p.budgetPeriod!, now);
    if (nextReset === null) {
      db.update(provider)
        .set({ budgetPeriod: null, budgetResetAt: null })
        .where(and(eq(provider.id, p.id), eq(provider.projectId, p.projectId)))
        .run();
      console.warn(
        `[budget-reset] Disabled invalid Provider period for project ${p.projectId}, provider ${p.id}`,
      );
      continue;
    }
    if (!p.budgetResetAt || p.budgetResetAt > nowIso) continue;

    await db
      .update(provider)
      .set({ budgetSpend: 0, budgetResetAt: nextReset })
      .where(and(eq(provider.id, p.id), eq(provider.projectId, p.projectId)));
  }
}

export function startBudgetReset(): void {
  if (resetTimer) return;
  resetTimer = setInterval(() => {
    runBudgetReset().catch((err) => console.error("[budget-reset] error:", err));
  }, 60_000); // Check every minute
  if (resetTimer.unref) resetTimer.unref();
}

export function stopBudgetReset(): void {
  if (resetTimer) {
    clearInterval(resetTimer);
    resetTimer = null;
  }
}
