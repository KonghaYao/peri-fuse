/**
 * Langfuse API 客户端和离线分析共用逻辑。
 * 报表只投影计数、时长和固定分类；不得返回或打印 input/output/error 正文。
 */
const BASE_URL = (process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || "").replace(
  /\/$/,
  "",
);
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";

export async function api(path: string) {
  if (!BASE_URL || !PUBLIC_KEY || !SECRET_KEY) {
    throw new Error("Missing LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY env vars");
  }
  const authHeader = `Basic ${btoa(`${PUBLIC_KEY}:${SECRET_KEY}`)}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`API ${path}: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json"))
    throw new Error(`API ${path}: expected JSON response`);
  return res.json();
}

const MAX_TRACE_LIMIT = 100;

export function clampTraceLimit(value: number, fallback = 50) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_TRACE_LIMIT) : fallback;
}

export async function fetchTraces(limit: number) {
  const data = await api(`/api/public/traces?limit=${clampTraceLimit(limit)}`);
  return (data.data || []) as any[];
}

export interface TraceFilter {
  limit?: number;
  page?: number;
  fromTimestamp?: string;
  toTimestamp?: string;
  tags?: string[];
  userId?: string;
  sessionId?: string;
  name?: string;
  orderBy?: string;
}

export async function fetchTracesFiltered(
  filter: TraceFilter,
): Promise<{ traces: any[]; meta: any }> {
  const params = new URLSearchParams();
  if (filter.limit) params.set("limit", String(clampTraceLimit(filter.limit)));
  if (filter.page) params.set("page", String(filter.page));
  if (filter.fromTimestamp) params.set("fromTimestamp", filter.fromTimestamp);
  if (filter.toTimestamp) params.set("toTimestamp", filter.toTimestamp);
  if (filter.tags?.length) params.set("tags", filter.tags.join(","));
  if (filter.userId) params.set("userId", filter.userId);
  if (filter.sessionId) params.set("sessionId", filter.sessionId);
  if (filter.name) params.set("name", filter.name);
  if (filter.orderBy) params.set("orderBy", filter.orderBy);
  const data = await api(`/api/public/traces?${params.toString()}`);
  return { traces: (data.data || []) as any[], meta: data.meta || {} };
}

export async function fetchAllTracesFiltered(
  filter: Omit<TraceFilter, "page"> & { maxPages?: number },
): Promise<any[]> {
  const all: any[] = [];
  const maxPages = filter.maxPages ?? 20;
  for (let page = 1; page <= maxPages; page++) {
    const { traces, meta } = await fetchTracesFiltered({
      ...filter,
      page,
      limit: clampTraceLimit(filter.limit || 50),
    });
    all.push(...traces);
    if (page >= (meta.totalPages || 1) || traces.length === 0) break;
  }
  return all;
}

export async function fetchObservations(traceId: string) {
  const all: any[] = [];
  for (let page = 1; ; page++) {
    const data = await api(`/api/public/observations?traceId=${traceId}&limit=100&page=${page}`);
    const items = (data.data || []) as any[];
    all.push(...items);
    if (page >= (data.meta?.totalPages || 1)) break;
  }
  return all;
}

export interface ObservationTreeAudit {
  duplicateIds: string[];
  missingParents: { id: string; parentObservationId: string }[];
  cycles: string[][];
}

/** 只检查 observation 身份与父链，不投影 input/output 正文。 */
export function auditObservationTree(observations: any[], traceId: string): ObservationTreeAudit {
  const counts = new Map<string, number>();
  const parentById = new Map<string, string | undefined>();
  for (const observation of observations) {
    const id = typeof observation?.id === "string" ? observation.id : "";
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
    if (!parentById.has(id)) {
      parentById.set(
        id,
        typeof observation.parentObservationId === "string" && observation.parentObservationId
          ? observation.parentObservationId
          : undefined,
      );
    }
  }

  const knownIds = new Set(parentById.keys());
  const duplicateIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const missingParents = [...parentById.entries()]
    .filter(([, parentId]) => parentId && parentId !== traceId && !knownIds.has(parentId))
    .map(([id, parentObservationId]) => ({ id, parentObservationId: parentObservationId! }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const cycles: string[][] = [];
  const completed = new Set<string>();
  for (const startId of [...knownIds].sort()) {
    if (completed.has(startId)) continue;
    const path: string[] = [];
    const pathIndexes = new Map<string, number>();
    let currentId: string | undefined = startId;
    while (currentId && knownIds.has(currentId) && !completed.has(currentId)) {
      const cycleStart = pathIndexes.get(currentId);
      if (cycleStart !== undefined) {
        cycles.push([...path.slice(cycleStart), currentId]);
        break;
      }
      pathIndexes.set(currentId, path.length);
      path.push(currentId);
      const parentId = parentById.get(currentId);
      currentId = parentId === traceId ? undefined : parentId;
    }
    for (const id of path) completed.add(id);
  }

  return { duplicateIds, missingParents, cycles };
}

export async function fetchScores(traceId: string) {
  const all: any[] = [];
  for (let page = 1; ; page++) {
    const data = await api(`/api/public/scores?traceId=${traceId}&limit=100&page=${page}`);
    const items = (data.data || []) as any[];
    all.push(...items);
    if (page >= (data.meta?.totalPages || 1)) break;
  }
  return all;
}

export function isoNow() {
  return new Date().toISOString();
}
export function isoSpan(fromISO: string, days: number) {
  const date = new Date(fromISO);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export function parseTraceArg(args: string[]): { traceId?: string; index?: number } {
  const valueFlags = [
    "--index",
    "--from",
    "--to",
    "--days",
    "--tag",
    "--user",
    "--session",
    "--name",
    "--limit",
  ];
  const valuePositions = new Set<number>();
  for (const flag of valueFlags) {
    const index = args.indexOf(flag);
    if (index !== -1 && args[index + 1] !== undefined) valuePositions.add(index + 1);
  }
  const traceId = args.find(
    (value, index) => !value.startsWith("--") && !valuePositions.has(index),
  );
  const index = Number(args[args.indexOf("--index") + 1]);
  return { traceId, index: Number.isInteger(index) && index > 0 ? index : undefined };
}

export function parseTimeWindow(args: string[]): { from?: string; to?: string } {
  let from = args[args.indexOf("--from") + 1];
  let to = args[args.indexOf("--to") + 1];
  if (!args.includes("--from")) from = undefined;
  if (!args.includes("--to")) to = undefined;
  const daysIndex = args.indexOf("--days");
  if (daysIndex !== -1) {
    const days = Number(args[daysIndex + 1]);
    if (Number.isFinite(days)) {
      to ||= isoNow();
      from ||= isoSpan(to, days);
    }
  }
  return { from, to };
}

export function parseFilterArgs(args: string[]): {
  tag?: string;
  userId?: string;
  sessionId?: string;
  name?: string;
  model?: string;
  limit: number;
  time: { from?: string; to?: string };
} {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  let limit = clampTraceLimit(Number(value("--limit")) || 50);
  const valueFlags = [
    "--from",
    "--to",
    "--days",
    "--tag",
    "--user",
    "--session",
    "--name",
    "--model",
    "--limit",
  ];
  const valuePositions = new Set(
    valueFlags.flatMap((flag) => {
      const index = args.indexOf(flag);
      return index !== -1 && args[index + 1] !== undefined ? [index + 1] : [];
    }),
  );
  for (let index = 0; index < args.length; index++) {
    if (valuePositions.has(index)) continue;
    const positional = Number(args[index]);
    if (Number.isInteger(positional) && positional > 0) {
      limit = clampTraceLimit(positional);
      break;
    }
  }
  return {
    tag: value("--tag"),
    userId: value("--user"),
    sessionId: value("--session"),
    name: value("--name"),
    model: value("--model"),
    limit,
    time: parseTimeWindow(args),
  };
}

export * from "./format.ts";
export * from "./metrics.ts";
