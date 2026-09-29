import {
  isBackgroundSubagent,
  isGraphSubagent,
} from "@/shared/components/observation-trace-graph-semantics";
import type { Observation } from "@/shared/lib/types";

/** Rows represent events; fork/join rows preserve hidden AGENT control flow. */
export type TraceGraphNode = {
  id: string;
  observation: Observation | null;
  kind: "generation" | "tool" | "fork" | "join";
  lane: number;
  parentLane?: number;
  branchId: string;
  timestamp: number;
  label: string;
  background: boolean;
};

export type TraceGraphEdge = {
  id: string;
  from: { row: number; lane: number };
  to: { row: number; lane: number };
  kind: "sequence" | "fork" | "join";
  background: boolean;
  lane: number;
};

export type TraceGraphModel = {
  nodes: TraceGraphNode[];
  edges: TraceGraphEdge[];
  laneCount: number;
  hiddenCount: number;
  branchCount: number;
  startTime: number;
};

type Branch = {
  observation: Observation;
  lane: number;
  parentId: string | null;
  depth: number;
  background: boolean;
  start: number;
  last: number;
  end: number | null;
};

const MAIN_BRANCH_ID = "__main__";

function time(value: string | null): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Hidden spans bridge ancestry. Missing parents and cyclic chains fall back to main. */
function parentBranch(
  observation: Observation,
  byId: ReadonlyMap<string, Observation>,
): string | null {
  const seen = new Set([observation.id]);
  let parentId = observation.parentObservationId;
  let nearest: string | null = null;
  while (parentId) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (nearest === null && isGraphSubagent(parent)) nearest = parent.id;
    parentId = parent.parentObservationId;
  }
  return nearest;
}

/**
 * Build a deterministic Git-log projection without mutating API observations.
 * Only generation/tool spans are event dots. Each subagent owns a stable lane;
 * lanes are not reused in this demo, preserving branch identity during refreshes.
 * A recorded endTime closes synchronous branches; background work never implies a join.
 */
export function buildTraceGraph(observations: Observation[]): TraceGraphModel {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const unique = [...byId.values()];
  const validStarts = unique.flatMap((observation) => {
    const value = time(observation.startTime);
    return value === null ? [] : [value];
  });
  const startTime = validStarts.length ? Math.min(...validStarts) : 0;
  const starts = new Map(unique.map((o) => [o.id, time(o.startTime) ?? startTime]));
  // Stable sort preserves ingestion order for simultaneous events.
  const ordered = unique.slice().sort((a, b) => starts.get(a.id)! - starts.get(b.id)!);
  const branches = new Map<string, Branch>();
  for (const observation of ordered) {
    if (!isGraphSubagent(observation)) continue;
    const start = starts.get(observation.id)!;
    branches.set(observation.id, {
      observation,
      lane: branches.size + 1,
      parentId: parentBranch(observation, byId),
      depth: 1,
      background: isBackgroundSubagent(observation, byId),
      start,
      last: start,
      end: time(observation.endTime),
    });
  }
  for (const branch of branches.values()) {
    let parent = branch.parentId ? branches.get(branch.parentId) : undefined;
    while (parent) {
      branch.depth++;
      parent = parent.parentId ? branches.get(parent.parentId) : undefined;
    }
  }

  const nodes: TraceGraphNode[] = [];
  for (const observation of ordered) {
    if (observation.type !== "GENERATION" && observation.type !== "TOOL") continue;
    const branchId = parentBranch(observation, byId);
    const branch = branchId ? branches.get(branchId) : undefined;
    const timestamp = starts.get(observation.id)!;
    if (branch) {
      branch.start = Math.min(branch.start, timestamp);
      branch.last = Math.max(branch.last, timestamp);
    }
    nodes.push({
      id: observation.id,
      observation,
      kind: observation.type === "GENERATION" ? "generation" : "tool",
      lane: branch?.lane ?? 0,
      branchId: branch?.observation.id ?? MAIN_BRANCH_ID,
      timestamp,
      label: observation.name ?? (observation.type === "GENERATION" ? "Generation" : "Tool"),
      background: branch?.background ?? false,
    });
  }

  // Clock skew must not place child dots before their fork or after their join.
  // Background children can outlive their parent and therefore do not delay its join.
  const deepestFirst = [...branches.values()].sort((a, b) => b.depth - a.depth);
  for (const branch of deepestFirst) {
    if (branch.end !== null) branch.end = Math.max(branch.end, branch.last, branch.start);
    const parent = branch.parentId ? branches.get(branch.parentId) : undefined;
    if (parent) {
      parent.start = Math.min(parent.start, branch.start);
      parent.last = Math.max(
        parent.last,
        branch.start,
        !branch.background && branch.end !== null ? branch.end : branch.start,
      );
    }
  }
  for (const branch of branches.values()) {
    const parentLane = branch.parentId ? (branches.get(branch.parentId)?.lane ?? 0) : 0;
    const base = {
      observation: branch.observation,
      branchId: branch.observation.id,
      label: branch.observation.name ?? "Subagent",
      background: branch.background,
      parentLane,
    };
    nodes.push({
      ...base,
      id: `fork:${branch.observation.id}`,
      kind: "fork",
      lane: branch.lane,
      timestamp: branch.start,
    });
    if (!branch.background && branch.end !== null) {
      nodes.push({
        ...base,
        id: `join:${branch.observation.id}`,
        kind: "join",
        lane: parentLane,
        timestamp: branch.end,
      });
    }
  }
  const priority = (node: TraceGraphNode) => {
    const depth = branches.get(node.branchId)?.depth ?? 0;
    if (node.kind === "fork") return -100000 + depth;
    if (node.kind === "join") return 100000 - depth;
    return 0;
  };
  nodes.sort((a, b) => a.timestamp - b.timestamp || priority(a) - priority(b));

  return {
    nodes,
    edges: buildEdges(nodes, branches),
    laneCount: branches.size + 1,
    hiddenCount: unique.filter(
      (o) => o.type !== "GENERATION" && o.type !== "TOOL" && !isGraphSubagent(o),
    ).length,
    branchCount: branches.size,
    startTime,
  };
}

function buildEdges(
  nodes: TraceGraphNode[],
  branches: ReadonlyMap<string, Branch>,
): TraceGraphEdge[] {
  const edges: TraceGraphEdge[] = [];
  const last = new Map<number, { row: number; lane: number }>();
  const connect = (
    from: TraceGraphEdge["from"],
    to: TraceGraphEdge["to"],
    kind: TraceGraphEdge["kind"],
    lane: number,
    background = false,
  ) => {
    if (from.row === to.row && from.lane === to.lane) return;
    edges.push({ id: `edge:${edges.length}`, from, to, kind, lane, background });
  };
  const advance = (point: TraceGraphEdge["to"]) => {
    const previous = last.get(point.lane);
    if (previous) connect(previous, point, "sequence", point.lane);
    last.set(point.lane, point);
  };
  nodes.forEach((node, row) => {
    const point = { row, lane: node.lane };
    if (node.kind === "fork") {
      const parentPoint = { row, lane: node.parentLane ?? 0 };
      const source = last.get(parentPoint.lane) ?? parentPoint;
      connect(source, point, "fork", node.lane, node.background);
      advance(parentPoint);
      last.set(node.lane, point);
    } else if (node.kind === "join") {
      const branchLane = branches.get(node.branchId)?.lane;
      const source = branchLane === undefined ? undefined : last.get(branchLane);
      if (source) connect(source, point, "join", branchLane ?? node.lane);
      advance(point);
    } else {
      advance(point);
    }
  });
  return edges;
}
