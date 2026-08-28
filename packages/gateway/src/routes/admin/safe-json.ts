interface StoredJsonMeta {
  projectId: string;
  entity: string;
  id: string;
  field: string;
}

/**
 * Parse JSON stored in an Admin-facing database column without making one corrupt row fatal.
 * Database nulls remain null and diagnostics identify only the scoped row and field, never its value.
 */
export function parseStoredJson(
  value: string | null,
  fallback: unknown,
  meta: StoredJsonMeta,
): unknown {
  if (value === null) return null;

  try {
    return JSON.parse(value);
  } catch {
    console.warn("[peri-gateway] Invalid stored JSON", meta);
    return fallback;
  }
}
