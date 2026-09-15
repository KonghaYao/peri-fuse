/** Dashboard-only data helpers (scales live in @peri/ui Chart). */

/** "2026-01-15" → "01-15" for compact x-axis ticks. */
export function dayTick(date: string): string {
  return date.slice(5);
}
