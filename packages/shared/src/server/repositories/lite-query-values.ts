/** Parse a JSON string safely, returning fallback on failure. */
export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Convert SQLite boolean (0/1) to JS boolean. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

/** Ensure a date string from SQLite is in ClickHouse-compatible format. */
export function toDateStr(value: unknown): string {
  if (!value) return new Date().toISOString().replace("T", " ").replace("Z", "");
  const s = String(value);
  // If it already has fractional seconds, return as-is
  if (s.includes(".")) return s;
  return `${s}.000000`;
}

/** Parse a usage/cost details field from SQLite (JSON string) to Record<string, number>. */
export function toUsageRecord(value: unknown): Record<string, number> {
  const obj = safeJsonParse<Record<string, unknown>>(value, {});
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) {
      const num = Number(v);
      if (!Number.isNaN(num)) {
        result[k] = num;
      }
    }
  }
  return result;
}
