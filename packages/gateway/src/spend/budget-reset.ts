/**
 * Budget reset scheduler.
 * Periodically checks and resets budgets whose duration has elapsed.
 */
import { getDb } from "../db.js";

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
  const now = new Date();

  // Reset Budget entries
  const expiredBudgets = await db.budget.findMany({
    where: { resetAt: { lte: now }, duration: { not: null } },
  });

  for (const budget of expiredBudgets) {
    const durationMs = parseDuration(budget.duration!);
    if (!durationMs) continue;

    const nextReset = new Date(now.getTime() + durationMs);

    // Reset spend on all keys with this budget
    await db.apiKey.updateMany({
      where: { budgetId: budget.id },
      data: { spend: 0 },
    });

    await db.budget.update({
      where: { id: budget.id },
      data: { resetAt: nextReset, updatedAt: now },
    });
  }

  // Reset Provider budget spends
  const expiredProviders = await db.provider.findMany({
    where: { budgetResetAt: { lte: now }, budgetPeriod: { not: null } },
  });

  for (const provider of expiredProviders) {
    const durationMs = parseDuration(provider.budgetPeriod!);
    if (!durationMs) continue;

    const nextReset = new Date(now.getTime() + durationMs);

    await db.provider.update({
      where: { id: provider.id },
      data: { budgetSpend: 0, budgetResetAt: nextReset, updatedAt: now },
    });
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
