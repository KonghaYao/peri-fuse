/** Creates an Error carrying a stable machine-readable `code` for callers and tests. */
export function createDatabaseError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function isDatabaseConstraint(error: unknown, kind: "unique" | "foreign-key"): boolean {
  const pattern =
    kind === "unique" ? /UNIQUE constraint failed/i : /FOREIGN KEY constraint failed/i;
  const code = kind === "unique" ? "SQLITE_CONSTRAINT_UNIQUE" : "SQLITE_CONSTRAINT_FOREIGNKEY";
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const value = current as { code?: string; message?: string; cause?: unknown };
    if (value.code === code || pattern.test(value.message ?? "")) return true;
    current = value.cause;
  }
  return false;
}
