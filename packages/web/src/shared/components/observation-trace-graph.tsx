import { ArrowDown, GitBranch } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTraceGraphDisplay,
  type TraceGraphDisplayRow,
} from "@/shared/components/observation-trace-graph-display-layout";
import {
  buildTraceGraph,
  type TraceGraphEdge,
  type TraceGraphNode,
} from "@/shared/components/observation-trace-graph-layout";
import {
  TRACE_GRAPH_COLUMNS,
  TraceGraphRow,
  traceGraphTypeColor,
} from "@/shared/components/observation-trace-graph-rows";
import type { Observation } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

const LANE_WIDTH = 16;
const GRAPH_PADDING = 14;
const LANE_COLORS = ["var(--brand)", "#a879e8", "#2bb9a6", "#e2a146", "#e279a4", "#64a8e5"];

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH;
const rowY = (rows: TraceGraphDisplayRow[], row: number) => rows[row].top + rows[row].height / 2;

function edgePath(edge: TraceGraphEdge, rows: TraceGraphDisplayRow[]): string {
  const x1 = laneX(edge.from.lane);
  const y1 = rowY(rows, edge.from.row);
  const x2 = laneX(edge.to.lane);
  const y2 = rowY(rows, edge.to.row);
  if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
  const middleY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`;
}

function GraphPoint({
  node,
  lane,
  y,
  selected,
}: {
  node: TraceGraphNode;
  lane: number;
  y: number;
  selected: boolean;
}) {
  const x = laneX(lane);
  const color = "currentColor";
  return (
    <g data-graph-node={node.kind} className={traceGraphTypeColor(node)}>
      {selected && <circle cx={x} cy={y} r={8} fill={color} opacity={0.16} />}
      <circle cx={x} cy={y} r={6} fill="var(--surface-raised)" />
      {node.kind === "tool" ? (
        <rect
          x={x - 3.5}
          y={y - 3.5}
          width={7}
          height={7}
          rx={1}
          transform={`rotate(45 ${x} ${y})`}
          fill={color}
          stroke="var(--surface-raised)"
          strokeWidth={1}
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={node.kind === "generation" ? 3.5 : 2.5}
          fill={node.kind === "fork" ? "var(--surface-raised)" : color}
          stroke={color}
          strokeWidth={1.5}
        />
      )}
    </g>
  );
}

/**
 * Git-style execution order. Rows represent events or consecutive tools; timestamps describe
 * relative start time while branch lines describe ancestry, not duration.
 * The caller owns scrolling and observation detail loading.
 */
export function ObservationTraceGraph({
  observations,
  selectedId,
  onSelect,
  className,
  headerActions,
}: {
  observations: Observation[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
  headerActions?: ReactNode;
}) {
  const [compact, setCompact] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(760);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (width > 0) setContainerWidth(width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const model = useMemo(() => buildTraceGraph(observations), [observations]);
  const graphWidth = Math.max(32, laneX(model.laneCount - 1) + 16);
  const groupColumns = Math.max(
    1,
    Math.floor((Math.max(containerWidth, graphWidth + 500) - graphWidth - 80) / 144),
  );
  const display = useMemo(
    () => buildTraceGraphDisplay(model, compact, groupColumns),
    [model, compact, groupColumns],
  );
  return (
    <div ref={containerRef} className={cn("min-w-0 bg-surface-raised", className)}>
      <div style={{ minWidth: graphWidth + 500 }}>
        <div
          className={cn(
            TRACE_GRAPH_COLUMNS,
            "h-8 border-b border-line bg-surface-inset text-left text-[10px] uppercase tracking-wide text-fg-tertiary",
          )}
          style={{ paddingLeft: graphWidth }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">Observation / agent output</span>
            <span className="shrink-0 normal-case">{headerActions}</span>
            <button
              type="button"
              aria-label={compact ? "Show individual rows" : "Group consecutive tools"}
              aria-pressed={!compact}
              title={compact ? "Show individual rows" : "Group consecutive tools"}
              onClick={() => setCompact((value) => !value)}
              className="shrink-0 rounded px-1 py-1 normal-case hover:bg-surface-overlay focus-visible:outline-2 focus-visible:outline-brand"
            >
              {compact ? "Rows" : "Compact"}
            </button>
          </div>
          <span>Model / tokens</span>
          <span className="text-right">Duration</span>
          <span className="text-right">Time</span>
        </div>
        {model.nodes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <GitBranch className="h-7 w-7 text-fg-tertiary/60" />
            <p className="text-sm text-fg-secondary">No generation or tool calls yet</p>
            <p className="text-xs text-fg-tertiary">
              Generation and tool calls will appear as trace points.
            </p>
          </div>
        ) : (
          <div className="relative">
            {display.rows.map((row) => (
              <TraceGraphRow
                key={row.id}
                row={row}
                startTime={model.startTime}
                graphWidth={graphWidth}
                groupColumns={groupColumns}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
            <svg
              aria-hidden="true"
              width={graphWidth}
              height={display.height}
              className="pointer-events-none absolute left-0 top-0"
            >
              {display.edges.map((edge) => (
                <path
                  key={edge.id}
                  d={edgePath(edge, display.rows)}
                  fill="none"
                  stroke={laneColor(edge.lane)}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeDasharray={edge.kind === "fork" && edge.background ? "4 4" : undefined}
                  opacity={0.7}
                />
              ))}
              {display.rows.map((row, index) => (
                <GraphPoint
                  key={row.id}
                  node={
                    row.nodes.find((node) => node.observation?.level === "ERROR") ?? row.nodes[0]
                  }
                  lane={row.lane}
                  y={rowY(display.rows, index)}
                  selected={row.nodes.some((node) =>
                    Boolean(node.observation && selectedId === node.observation.id),
                  )}
                />
              ))}
            </svg>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[10px] text-fg-tertiary">
        <span className="inline-flex items-center gap-1">
          <ArrowDown className="h-3 w-3" /> Time order ·{" "}
          {compact ? "consecutive tools and sibling forks grouped" : "one event per row"}
        </span>
        <span className="ml-auto">{model.hiddenCount} ordinary spans hidden</span>
      </div>
    </div>
  );
}
