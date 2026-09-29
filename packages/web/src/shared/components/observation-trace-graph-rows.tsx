import type { CSSProperties, ReactNode } from "react";
import type { TraceGraphDisplayRow } from "@/shared/components/observation-trace-graph-display-layout";
import type { TraceGraphNode } from "@/shared/components/observation-trace-graph-layout";
import { formatDuration, formatMs, formatTokens } from "@/shared/lib/format";
import { getGenerationPreview } from "@/shared/lib/generation-preview";
import { cn } from "@/shared/lib/utils";

export const TRACE_GRAPH_COLUMNS =
  "grid grid-cols-[minmax(240px,1fr)_100px_64px_68px] items-center gap-1.5 pr-2";

type Selection = { selectedId?: string | null; onSelect?: (id: string) => void };

function Selectable({
  node,
  selectedId,
  onSelect,
  className,
  children,
  style,
  titleExtra,
}: Selection & {
  node: TraceGraphNode;
  className: string;
  children: ReactNode;
  style?: CSSProperties;
  titleExtra?: string;
}) {
  const observation = node.observation;
  const selected = Boolean(observation && selectedId === observation.id);
  const title = [
    node.label,
    node.kind === "generation" ? getGenerationPreview(observation?.output, 300) : null,
    observation?.statusMessage,
    titleExtra,
  ]
    .filter(Boolean)
    .join("\n");
  const classes = cn(
    "text-left transition-colors",
    selected ? "bg-brand-subtle shadow-[inset_2px_0_0_var(--brand)]" : "hover:bg-surface-inset/70",
    onSelect &&
      observation &&
      "cursor-pointer focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-[-2px]",
    className,
  );
  return onSelect && observation ? (
    <button
      type="button"
      className={classes}
      style={style}
      title={title}
      aria-pressed={selected}
      onClick={() => onSelect(observation.id)}
    >
      {children}
    </button>
  ) : (
    <div className={classes} style={style} title={title}>
      {children}
    </div>
  );
}

/** Nodes and type labels share semantic colors, independent of branch line colors. */
export function traceGraphTypeColor(node: TraceGraphNode) {
  if (node.kind === "fork" || node.kind === "join") return "text-gray-500 dark:text-gray-400";
  if (node.observation?.level === "ERROR") return "text-danger";
  if (node.kind === "generation") return "text-blue-600 dark:text-blue-400";
  return "text-orange-400 dark:text-orange-300";
}

/** Plain colored type labels leave the branch markers and names easy to scan. */
function TypeText({ node }: { node: TraceGraphNode }) {
  const label = {
    generation: "GEN",
    tool: "TOOL",
    fork: node.background ? "BG" : "FORK",
    join: "JOIN",
  }[node.kind];
  return (
    <span
      data-graph-type={node.kind}
      className={cn(
        "w-7 shrink-0 font-mono text-[10px] font-semibold tracking-wide",
        traceGraphTypeColor(node),
      )}
    >
      {label}
    </span>
  );
}

function Duration({ node }: { node: TraceGraphNode }) {
  const observation = node.observation;
  if (!observation || node.kind === "fork" || node.kind === "join") return "—";
  return observation.endTime ? (
    formatDuration(observation.startTime, observation.endTime)
  ) : (
    <span className="inline-flex items-center gap-1 text-brand">
      <span className="h-1.5 w-1.5 rounded-full bg-brand motion-safe:animate-pulse" /> running
    </span>
  );
}

function ErrorMark({ node }: { node: TraceGraphNode }) {
  return node.observation?.level === "ERROR" ? (
    <span className="shrink-0 text-[9px] font-semibold text-danger">ERROR</span>
  ) : null;
}

function NodeGroup({
  row,
  startTime,
  graphWidth,
  ...selection
}: Selection & {
  row: TraceGraphDisplayRow;
  startTime: number;
  graphWidth: number;
}) {
  const forkGroup = row.nodes[0].kind === "fork";
  const typeNode = row.nodes.find((node) => node.observation?.level === "ERROR") ?? row.nodes[0];
  return (
    <div
      data-tool-group={forkGroup ? undefined : row.nodes.length}
      data-fork-group={forkGroup ? row.nodes.length : undefined}
      className="relative flex items-center gap-1.5 pr-2"
      style={{ height: row.height, paddingLeft: graphWidth }}
    >
      <TypeText node={forkGroup ? { ...typeNode, background: false } : typeNode} />
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
        {row.nodes.map((node) => (
          <Selectable
            key={node.id}
            node={node}
            {...selection}
            titleExtra={`Started +${formatMs(node.timestamp - startTime)}`}
            className="inline-flex h-5 max-w-[210px] shrink-0 items-center gap-1 whitespace-nowrap rounded border border-line/70 bg-surface-inset/30 px-1.5"
          >
            <span
              className={cn(
                "truncate text-[11px] font-medium",
                forkGroup ? "max-w-[180px]" : "max-w-[120px]",
                node.observation?.level === "ERROR" ? "text-danger" : "text-fg-primary",
              )}
            >
              {node.label}
            </span>
            <ErrorMark node={node} />
            <span className="tnum shrink-0 font-mono text-[10px] text-fg-tertiary">
              {forkGroup ? node.background ? "BG" : "Sync" : <Duration node={node} />}
            </span>
          </Selectable>
        ))}
        <span
          className="shrink-0 text-[10px] text-fg-tertiary"
          title={
            forkGroup
              ? "Subagents sharing a launch point"
              : "Consecutive tools, ordered left to right"
          }
        >
          ×{row.nodes.length}
        </span>
      </div>
    </div>
  );
}

/** GEN rows anchor agent text; compact groups keep every tool and subagent selectable. */
export function TraceGraphRow({
  row,
  startTime,
  graphWidth,
  ...selection
}: Selection & {
  row: TraceGraphDisplayRow;
  startTime: number;
  graphWidth: number;
}) {
  if (row.nodes.length > 1)
    return <NodeGroup row={row} startTime={startTime} graphWidth={graphWidth} {...selection} />;
  const node = row.nodes[0];
  const observation = node.observation;
  const structural = node.kind === "fork" || node.kind === "join";
  const preview = node.kind === "generation" ? getGenerationPreview(observation?.output) : null;
  const modelLabel = structural
    ? node.kind === "join"
      ? "Returned"
      : node.background
        ? "Background"
        : "Synchronous"
    : [
        observation?.model,
        observation?.totalTokens ? `${formatTokens(observation.totalTokens)} tok` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <Selectable
      node={node}
      {...selection}
      className={cn(TRACE_GRAPH_COLUMNS, "relative w-full whitespace-nowrap")}
      style={{ height: row.height, paddingLeft: graphWidth }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <TypeText node={node} />
        {node.kind === "generation" ? (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              preview ? "text-fg-secondary" : "italic text-fg-tertiary",
            )}
            title={getGenerationPreview(observation?.output, 300) ?? undefined}
          >
            {preview ?? (observation?.output === undefined ? "Loading output…" : "No text output")}
          </span>
        ) : (
          <span
            className={cn(
              "truncate text-xs",
              structural ? "font-medium text-fg-secondary" : "font-semibold text-fg-primary",
              observation?.level === "ERROR" && "text-danger",
            )}
          >
            {node.label}
          </span>
        )}
        <ErrorMark node={node} />
        {node.kind === "generation" && (
          <span className="max-w-[96px] shrink-0 truncate font-mono text-[10px] text-fg-tertiary">
            {node.label}
          </span>
        )}
      </span>
      <span className="truncate text-[10px] text-fg-tertiary" title={modelLabel}>
        {modelLabel || "—"}
      </span>
      <span className="tnum text-right font-mono text-[10px] text-fg-secondary">
        <Duration node={node} />
      </span>
      <span
        className="tnum text-right font-mono text-[10px] text-fg-tertiary"
        title="Time relative to trace start"
      >
        +{formatMs(node.timestamp - startTime)}
      </span>
    </Selectable>
  );
}
