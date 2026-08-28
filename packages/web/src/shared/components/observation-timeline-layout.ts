import type { Observation } from "@/shared/lib/types";

/** Positioned observation consumed by timeline rendering; coordinates are relative to trace start. */
export type BandSegment = {
  id: string;
  obs: Observation;
  startMs: number;
  endMs: number;
  running: boolean;
  lane: number;
  traceIndex?: number;
};

/** One observation-type track and the vertical lanes required by its overlapping segments. */
export type TypeLaneGroup = {
  type: string;
  segments: BandSegment[];
  laneCount: number;
};

/** Stable display order for known observation-type tracks; unknown types follow afterward. */
export const TYPE_ORDER = [
  "AGENT",
  "CHAIN",
  "GENERATION",
  "TOOL",
  "RETRIEVER",
  "EVALUATOR",
  "EMBEDDING",
  "GUARDRAIL",
  "SPAN",
  "EVENT",
];

/**
 * Assign observations to non-overlapping vertical lanes without rendering concerns.
 * Missing end times remain running until the supplied timeline boundary.
 */
export function layoutLanes(
  observations: Observation[],
  t0: number,
  totalMs: number,
  traceOf?: Map<string, number>,
): BandSegment[] {
  const items = observations
    .map((o) => {
      const startMs = new Date(o.startTime).getTime() - t0;
      const endMs = o.endTime ? new Date(o.endTime).getTime() - t0 : null;
      const isInstant = o.type === "EVENT" || (endMs !== null && endMs <= startMs);
      return {
        id: o.id,
        obs: o,
        startMs,
        endMs: isInstant ? startMs : (endMs ?? totalMs),
        running: !isInstant && endMs === null,
        lane: 0,
        traceIndex: traceOf?.get(o.id),
      };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const laneEnds: number[] = [];
  for (const item of items) {
    let lane = laneEnds.findIndex((end) => end <= item.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = item.endMs;
    item.lane = lane;
  }
  return items;
}

/**
 * Pure layout boundary: group observations into stable type tracks and collision-free lanes.
 * Unknown observation types are appended after the known display order.
 */
export function layoutTypeLanes(
  observations: Observation[],
  t0: number,
  totalMs: number,
  traceOf?: Map<string, number>,
): TypeLaneGroup[] {
  const byType = new Map<string, Observation[]>();
  for (const observation of observations) {
    const items = byType.get(observation.type) ?? [];
    items.push(observation);
    byType.set(observation.type, items);
  }

  const groups: TypeLaneGroup[] = [];
  const pushGroup = (type: string) => {
    const observationsForType = byType.get(type);
    if (!observationsForType || observationsForType.length === 0) return;
    const segments = layoutLanes(observationsForType, t0, totalMs, traceOf);
    const laneCount = segments.reduce((maximum, segment) => Math.max(maximum, segment.lane + 1), 0);
    groups.push({ type, segments, laneCount });
  };

  for (const type of TYPE_ORDER) pushGroup(type);
  for (const type of byType.keys()) {
    if (!TYPE_ORDER.includes(type)) pushGroup(type);
  }
  return groups;
}
