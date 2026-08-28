const MAX_LIST_LIMIT = 200;

interface AdminListQuery {
  limit: number;
  offset: number;
  startDate?: string;
  endDate?: string;
}

type AdminListQueryResult = { ok: true; value: AdminListQuery } | { ok: false; message: string };

function parseInteger(
  value: string | undefined,
  pattern: RegExp,
  minimum: number,
  fallback: number,
): number | null {
  if (value === undefined) return fallback;
  if (!pattern.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Parse pagination and date boundaries shared by Gateway Admin list routes.
 * Errors are returned in stable priority order so callers can map them to HTTP 400.
 */
export function parseAdminListQuery(raw: Record<string, string>): AdminListQueryResult {
  const limit = parseInteger(raw.limit, /^[1-9]\d*$/, 1, 50);
  if (limit === null || limit > MAX_LIST_LIMIT) {
    return { ok: false, message: "limit must be an integer between 1 and 200" };
  }

  const offset = parseInteger(raw.offset, /^(0|[1-9]\d*)$/, 0, 0);
  if (offset === null) {
    return { ok: false, message: "offset must be a non-negative integer" };
  }

  if (raw.startDate !== undefined && !isCanonicalUtcTimestamp(raw.startDate)) {
    return {
      ok: false,
      message: "startDate must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
    };
  }
  if (raw.endDate !== undefined && !isCanonicalUtcTimestamp(raw.endDate)) {
    return {
      ok: false,
      message: "endDate must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
    };
  }
  if (raw.startDate !== undefined && raw.endDate !== undefined && raw.startDate > raw.endDate) {
    return { ok: false, message: "startDate must be on or before endDate" };
  }

  return {
    ok: true,
    value: { limit, offset, startDate: raw.startDate, endDate: raw.endDate },
  };
}
