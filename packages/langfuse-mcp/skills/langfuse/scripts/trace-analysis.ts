/** Trace analysis model shared by the report presentation. */
import {
  fetchObservations,
  genTokens,
  type LatencySummary,
  summarizeLatency,
  summarizeObservationLatency,
  totalInputTraffic,
} from "./lib.ts";

export async function fetchAllObservations(traces: any[]) {
  const map = new Map<string, any[]>();
  for (let i = 0; i < traces.length; i += 5) {
    const batch = traces.slice(i, i + 5);
    const results = await Promise.all(batch.map((t: any) => fetchObservations(t.id)));
    for (let j = 0; j < batch.length; j++) {
      map.set(batch[j].id, results[j]);
    }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════
// Core analysis types
// ═══════════════════════════════════════════════════════════════

interface GenDetail {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  latency: number | null;
}

interface ToolDetail {
  name: string;
  latency: number | null;
  status: string;
  parentGenIdx: number;
}

export interface TraceAnalysis {
  id: string;
  timestamp: string;
  sessionId: string;
  latency: LatencySummary;
  llmCalls: number;
  toolCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCache: number;
  totalCacheCreation: number;
  cachePct: number;
  effective: number;
  genDetails: GenDetail[];
  toolDetails: ToolDetail[];
  observations: any[];
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
// Analysis functions
// ═══════════════════════════════════════════════════════════════

export function analyzeTrace(trace: any, observations: any[]): TraceAnalysis {
  const gens = observations.filter((o) => o.type === "GENERATION");
  const tools = observations.filter((o) => o.type === "TOOL");

  let totalInput = 0,
    totalOutput = 0,
    totalCache = 0,
    totalCacheCreation = 0;

  const genDetails: GenDetail[] = gens.map((g) => {
    const tokens = genTokens(g);
    totalInput += tokens.input;
    totalOutput += tokens.output;
    totalCache += tokens.cacheRead;
    totalCacheCreation += tokens.cacheCreate;
    return {
      model:
        g.providedModelName ||
        g.internalModelId ||
        g.model ||
        g.metadata?.attributes?.["langfuse.observation.model.name"] ||
        "?",
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheCreation: tokens.cacheCreate,
      latency: summarizeObservationLatency(g),
    };
  });

  const genIds = gens.map((g) => g.id);
  const toolDetails: ToolDetail[] = tools.map((t) => {
    const parentIdx = genIds.reduce((best, _gid, idx) => {
      if (t.startTime >= gens[idx].startTime) return idx;
      return best;
    }, -1);
    return {
      name: t.name || t.metadata?.toolName || "unknown",
      latency: summarizeObservationLatency(t),
      status: t.status || "success",
      parentGenIdx: parentIdx,
    };
  });

  return {
    id: trace.id,
    timestamp: trace.timestamp || trace.createdAt || "",
    sessionId: trace.sessionId || "",
    latency: summarizeLatency(observations),
    llmCalls: gens.length,
    toolCalls: tools.length,
    totalInput,
    totalOutput,
    totalCache,
    totalCacheCreation,
    cachePct:
      totalInputTraffic({
        input: totalInput,
        cacheRead: totalCache,
        cacheCreate: totalCacheCreation,
      }) > 0
        ? (totalCache /
            totalInputTraffic({
              input: totalInput,
              cacheRead: totalCache,
              cacheCreate: totalCacheCreation,
            })) *
          100
        : 0,
    effective: totalInput,
    genDetails,
    toolDetails,
    observations,
  };
}
