/**
 * Adapters between lite-server observation types and @peri/ui monitor primitives.
 */

import {
  defaultIsNoiseObservation,
  type MonitorTimelineSegment,
  type MonitorTraceObservationFlat,
} from "@peri/ui";
import type { Observation, Score } from "@/shared/lib/types";

export type ScoreSummary = {
  id: string;
  name: string;
  value: number | null;
  stringValue: string | null;
  source: string;
};

export function toFlatObservation(observation: Observation): MonitorTraceObservationFlat {
  return {
    id: observation.id,
    parentId: observation.parentObservationId,
    type: observation.type,
    name: observation.name,
    startTime: observation.startTime,
    endTime: observation.endTime,
    level: observation.level,
    output: observation.output,
    inputTokens: observation.promptTokens,
    outputTokens: observation.completionTokens,
    totalTokens: observation.totalTokens,
  };
}

export function toFlatObservations(observations: Observation[]): MonitorTraceObservationFlat[] {
  return observations.map(toFlatObservation);
}

export function toScoreSummary(
  score:
    | Score
    | {
        id: string;
        name: string;
        value: number | null;
        stringValue: string | null;
        source: string;
      },
): ScoreSummary {
  return {
    id: score.id,
    name: score.name,
    value: score.value,
    stringValue: score.stringValue,
    source: score.source,
  };
}

function isSubagentObservation(observation: Observation): boolean {
  return observation.type === "AGENT" && (observation.name?.startsWith("subagent") ?? false);
}

/** Build relative-ms timeline segments for MonitorTimelineShell. */
export function buildTimelineSegments(
  observations: Observation[],
  options?: { omitNoise?: boolean; traceIndex?: number },
): MonitorTimelineSegment[] {
  const omitNoise = options?.omitNoise ?? true;
  const filtered = observations.filter((observation) => {
    if (isSubagentObservation(observation)) return false;
    if (omitNoise && defaultIsNoiseObservation(toFlatObservation(observation))) return false;
    if (omitNoise && (observation.name ?? "").startsWith("tool-batch")) return false;
    return true;
  });
  if (filtered.length === 0) return [];

  const t0 = Math.min(...filtered.map((o) => new Date(o.startTime).getTime()));
  const endTimes = filtered.flatMap((o) => {
    const start = new Date(o.startTime).getTime();
    const end = o.endTime ? new Date(o.endTime).getTime() : start;
    return [start, end];
  });
  const totalMs = Math.max(1, Math.max(...endTimes) - t0);

  return filtered.map((observation) => {
    const startMs = new Date(observation.startTime).getTime() - t0;
    const endMs = observation.endTime ? new Date(observation.endTime).getTime() - t0 : totalMs;
    return {
      id: observation.id,
      name: observation.name ?? observation.type,
      kind: observation.type,
      level: (observation.level?.toUpperCase() as MonitorTimelineSegment["level"]) ?? undefined,
      startMs,
      endMs,
      running: !observation.endTime,
      tokens: observation.totalTokens > 0 ? observation.totalTokens : undefined,
      traceIndex: options?.traceIndex,
      statusMessage: observation.statusMessage ?? undefined,
    };
  });
}

export function mergeTimelineSegments(
  traceObservations: Array<{ traceIndex: number; observations: Observation[] }>,
  omitNoise = true,
): MonitorTimelineSegment[] {
  return traceObservations.flatMap(({ traceIndex, observations }) =>
    buildTimelineSegments(observations, { omitNoise, traceIndex }),
  );
}
