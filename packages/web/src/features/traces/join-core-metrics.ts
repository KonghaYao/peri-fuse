import type { Trace, TraceMetrics } from "@/shared/lib/types";

export type LevelCounts = {
  errorCount: number;
  warningCount: number;
  debugCount: number;
  defaultCount: number;
};

export type TracesTableRow = {
  id: string;
  timestamp: string;
  name: string | null;
  userId: string | null;
  sessionId: string | null;
  release: string | null;
  version: string | null;
  environment: string | null;
  tags: string[];
  input: unknown;
  output: unknown;
  metadata: unknown;
  latency: number | null;
  observationCount: number | null;
  level: string | null;
  levelCounts: LevelCounts | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheHitRate: number | null;
};

/** Client-side join of core trace rows and per-trace metrics (by id). */
export function joinCoreAndMetrics(
  traces: Trace[],
  metrics: TraceMetrics[] | undefined,
): TracesTableRow[] {
  const byId = new Map((metrics ?? []).map((metric) => [metric.id, metric]));
  return traces.map((trace) => {
    const metric = byId.get(trace.id);
    return {
      id: trace.id,
      timestamp: trace.timestamp,
      name: trace.name,
      userId: trace.userId,
      sessionId: trace.sessionId,
      release: trace.release,
      version: trace.version,
      environment: trace.environment ?? null,
      tags: trace.tags,
      input: metric?.input ?? null,
      output: metric?.output ?? null,
      metadata: metric?.metadata ?? null,
      latency: metric?.latency ?? null,
      observationCount: metric?.observationCount ?? null,
      level: metric?.level ?? null,
      levelCounts: metric
        ? {
            errorCount: metric.errorCount,
            warningCount: metric.warningCount,
            debugCount: metric.debugCount,
            defaultCount: metric.defaultCount,
          }
        : null,
      promptTokens: metric?.promptTokens ?? null,
      completionTokens: metric?.completionTokens ?? null,
      totalTokens: metric?.totalTokens ?? null,
      cachedTokens: metric?.cachedTokens ?? null,
      cacheHitRate: metric?.cacheHitRate ?? null,
    };
  });
}
