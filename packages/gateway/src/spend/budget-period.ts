const PERIOD_PATTERN = /^([1-9]\d*)([mhd])$/;

const UNIT_MILLISECONDS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/**
 * Parse a positive minute/hour/day budget period into milliseconds.
 * Returns null for unsupported values and values that cannot be represented safely.
 */
export function parseBudgetPeriod(period: unknown): number | null {
  if (typeof period !== "string") return null;

  const match = PERIOD_PATTERN.exec(period);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MILLISECONDS;
  const milliseconds = value * UNIT_MILLISECONDS[unit];

  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/**
 * Compute the next ISO reset timestamp from an explicit clock value.
 * Returns null when either the period or resulting JavaScript date is invalid.
 */
export function nextBudgetResetAt(period: string, now: Date): string | null {
  const durationMs = parseBudgetPeriod(period);
  const nowMs = now.getTime();
  if (durationMs === null || !Number.isFinite(nowMs)) return null;

  const resetAt = new Date(nowMs + durationMs);
  return Number.isFinite(resetAt.getTime()) ? resetAt.toISOString() : null;
}
