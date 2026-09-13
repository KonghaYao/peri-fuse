/**
 * Provider cooldown manager.
 * Tracks consecutive failures and puts providers into cooldown.
 */
import { and, eq, lte } from "drizzle-orm";
import { provider } from "../db/schema.js";
import { getDb } from "../db.js";
import { BoundedTtlMap } from "../utils/bounded-ttl-map.js";

const COOLDOWN_THRESHOLD = 3; // consecutive failures before cooldown
const COOLDOWN_DURATION_MS = 60_000; // 60 seconds cooldown

// In-memory failure counters
const failureCounts = new BoundedTtlMap<number>(4096, 30 * 60_000);

/**
 * Record a successful call — resets the failure counter.
 */
export function recordSuccess(providerId: string, projectId: string): void {
  failureCounts.delete(JSON.stringify([projectId, providerId]));
}

/**
 * Record a failed call. After COOLDOWN_THRESHOLD consecutive failures,
 * puts the provider into cooldown.
 */
export async function recordFailure(providerId: string, projectId: string): Promise<void> {
  const key = JSON.stringify([projectId, providerId]);
  const count = (failureCounts.get(key) ?? 0) + 1;
  failureCounts.set(key, count);

  if (count >= COOLDOWN_THRESHOLD) {
    const cooldownUntil = new Date(Date.now() + COOLDOWN_DURATION_MS);
    const db = getDb();

    await db
      .update(provider)
      .set({
        status: "cooldown",
        cooldownUntil: cooldownUntil.toISOString(),
      })
      .where(and(eq(provider.id, providerId), eq(provider.projectId, projectId)));

    console.warn(
      `[router] Provider ${providerId} entered cooldown until ${cooldownUntil.toISOString()} (${count} consecutive failures)`,
    );

    // Reset counter after cooldown is set
    failureCounts.delete(JSON.stringify([projectId, providerId]));
  }
}

/**
 * Recover providers whose cooldown has expired.
 * Called periodically.
 */
export async function recoverCooldowns(): Promise<void> {
  const db = getDb();
  const nowIso = new Date().toISOString();

  await db
    .update(provider)
    .set({
      status: "healthy",
      cooldownUntil: null,
    })
    .where(and(eq(provider.status, "cooldown"), lte(provider.cooldownUntil, nowIso)));
}

// Start periodic cooldown recovery (every 10s)
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

export function startCooldownRecovery(): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    recoverCooldowns().catch((err) => {
      console.error("[router] Cooldown recovery error:", err);
    });
  }, 10_000);
  if (recoveryTimer.unref) recoveryTimer.unref();
}

export function stopCooldownRecovery(): void {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}
