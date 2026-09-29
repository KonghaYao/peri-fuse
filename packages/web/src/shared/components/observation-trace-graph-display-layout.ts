import type {
  TraceGraphEdge,
  TraceGraphModel,
  TraceGraphNode,
} from "@/shared/components/observation-trace-graph-layout";

export type TraceGraphDisplayRow = {
  id: string;
  nodes: TraceGraphNode[];
  lane: number;
  top: number;
  height: number;
};

function canGroup(anchor: TraceGraphNode, node: TraceGraphNode): boolean {
  if (anchor.kind === "tool" && node.kind === "tool") {
    return anchor.branchId === node.branchId && anchor.lane === node.lane;
  }
  return (
    anchor.kind === "fork" &&
    node.kind === "fork" &&
    (anchor.parentLane ?? 0) === (node.parentLane ?? 0)
  );
}

function isForkGroup(row: TraceGraphDisplayRow): boolean {
  return row.nodes.length > 1 && row.nodes[0].kind === "fork";
}

/** Group adjacent tools or sibling forks; a fork group has one shared launch point. */
export function buildTraceGraphDisplay(model: TraceGraphModel, compact: boolean) {
  const rows: TraceGraphDisplayRow[] = [];
  const displayIndex: number[] = [];
  for (const node of model.nodes) {
    const previous = rows.at(-1);
    const anchor = previous?.nodes[0];
    if (compact && previous && anchor && canGroup(anchor, node)) {
      previous.nodes.push(node);
    } else {
      rows.push({ id: node.id, nodes: [node], lane: node.lane, top: 0, height: 28 });
    }
    displayIndex.push(rows.length - 1);
  }
  let height = 0;
  for (const row of rows) {
    if (isForkGroup(row)) row.lane = row.nodes[0].parentLane ?? 0;
    row.top = height;
    height += row.height;
  }
  const edges: TraceGraphEdge[] = [];
  for (const edge of model.edges) {
    const sourceRow = rows[displayIndex[edge.from.row]];
    const targetRow = rows[displayIndex[edge.to.row]];
    // The parent sequence now reaches the shared marker. Each branch's launch
    // moves to its outgoing edge, retaining that branch's background mode.
    if (edge.kind === "fork" && isForkGroup(targetRow)) continue;
    const launchedBranch = isForkGroup(sourceRow)
      ? sourceRow.nodes.find((node) => node.lane === edge.from.lane)
      : undefined;
    const from = { ...edge.from, row: displayIndex[edge.from.row] };
    const to = { ...edge.to, row: displayIndex[edge.to.row] };
    if (launchedBranch) from.lane = sourceRow.lane;
    // A group's internal sequence is represented by its left-to-right cards.
    if (from.row === to.row && from.lane === to.lane) continue;
    edges.push({
      ...edge,
      from,
      to,
      ...(launchedBranch && edge.kind === "sequence"
        ? { kind: "fork", background: launchedBranch.background }
        : {}),
    });
  }
  return { rows, edges, height };
}
