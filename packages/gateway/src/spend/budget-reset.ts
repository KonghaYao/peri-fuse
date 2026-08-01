/**
 * Budget reset scheduler.
 * Periodically checks and resets budgets whose duration has elapsed.
 */
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "../db.js";
import { apiKey, budget, provider } from "../db/schema.js";

let resetTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Parse a duration string like "1d", "7d", "30d" into milliseconds.
 */
function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "d": return value * 24 * 60 * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "m": return value * 60 * 1000;
    default: return null;
  }
}

/**
 * Reset budgets and provider spends whose reset time has passed.
 */
async function performReset(): Promise<void> {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // Reset Budget entries
  const expiredBudgets = await db
    .select()
    .from(budget)
    .where(and(lte(budget.resetAt, nowIso), isNotNull(budget.duration)));

  for (const b of expiredBudgets) {
    const durationMs = parseDuration(b.duration!);
    if (!durationMs) continue;

    const nextReset = new Date(Date.now() + durationMs).toISOString();

    // Reset spend on all keys with this budget
    await db.update(apiKey).set({ spend: 0 }).where(eq(apiKey.budgetId, b.id));

    await db.update(budget).set({ resetAt: nextReset }).where(eq(budget.id, b.id));
  }

  // Reset Provider budget spends
  const expiredProviders = await db
    .select()
    .from(provider)
    .where(and(lte(provider.budgetResetAt, nowIso), isNotNull(provider.budgetPeriod)));

  for (const p of expiredProviders) {
    const durationMs = parseDuration(p.budgetPeriod!);
    if (!durationMs) continue;

    const nextReset = new Date(Date.now() + durationMs).toISOString();

    await db
      .update(provider)
      .set({ budgetSpend: 0, budgetResetAt: nextReset })
      .where(eq(provider.id, p.id));
  }
}

export function startBudgetReset(): void {
  if (resetTimer) return;
  resetTimer = setInterval(() => {
    performReset().catch((err) => console.error("[budget-reset] error:", err));
  }, 60_000); // Check every minute
  if (resetTimer.unref) resetTimer.unref();
}

export function stopBudgetReset(): void {
  if (resetTimer) {
    clearInterval(resetTimer);
    resetTimer = null;
  }
}
