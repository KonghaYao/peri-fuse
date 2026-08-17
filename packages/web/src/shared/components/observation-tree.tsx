/**
 * Observation tree — shared by the trace-detail page (selectable, drives the
 * detail panel) and the session-detail page (read-only, one merged tree per
 * session with a divider between traces).
 */

import { ChevronRight, Filter } from "lucide-react";
import { useState } from "react";
import { LevelBadge, ObservationTypeIcon } from "@/shared/components/observation-badges";
import { Button } from "@/shared/components/ui/button";
import { formatDuration } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

export type TreeNode = {
  observation: Observation;
  children: TreeNode[];
};

/**
 * Observations that are pure intermediate noise and hidden from the tree:
 * `stage-*` spans — agent internal phases (stage-reason / stage-act / ...)
 * that add little signal on top of the agent -> tool/generation chain.
 *
 * ERROR-level observations are always kept: even a `stage-*` node can carry
 * a failure signal (statusMessage) that must stay visible.
 */
function isNoiseObservation(o: Observation): boolean {
  if (o.level === "ERROR") return false;
  return o.name?.startsWith("stage-") ?? false;
}

/**
 * Builds a forest from the flat observation list using parentObservationId.
 * Children are sorted by startTime; observations whose parent is missing
 * (e.g. filtered out) are treated as roots.
 *
 * With `omitNoise` (default true) noise observations (see
 * `isNoiseObservation`) are hidden from the tree; their children are hoisted
 * onto the nearest visible ancestor so the agent -> tool/generation chain
 * stays intact.
 */
export function buildTree(
  observations: Observation[],
  opts: { omitNoise?: boolean } = {},
): TreeNode[] {
  const omitNoise = opts.omitNoise ?? true;
  const nodes = new Map<string, TreeNode>();
  const hidden = new Set<string>();
  for (const o of observations) {
    nodes.set(o.id, { observation: o, children: [] });
    if (omitNoise && isNoiseObservation(o)) hidden.add(o.id);
  }
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    if (hidden.has(node.observation.id)) continue;
    // Hoist: walk up the parent chain until the first visible ancestor.
    const visited = new Set<string>();
    let parentId = node.observation.parentObservationId;
    while (parentId && hidden.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = nodes.get(parentId);
      if (!parent) break;
      parentId = parent.observation.parentObservationId;
    }
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => a.observation.startTime.localeCompare(b.observation.startTime));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * Renders a single observation node and (recursively) its children.
 *
 * When `onSelect` is provided the row is clickable and highlights when
 * `selectedId` matches (trace-detail); without it the row is read-only
 * (session-detail merged tree).
 */
export function ObservationNode({
  node,
  depth,
  selectedId = null,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { observation: o } = node;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === o.id;
  const interactive = Boolean(onSelect);

  return (
    <div>
      <div
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={onSelect ? () => onSelect(o.id) : undefined}
        onKeyDown={onSelect ? (e) => e.key === "Enter" && onSelect(o.id) : undefined}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors",
          interactive && "cursor-pointer",
          isSelected
            ? "bg-brand-subtle text-fg-primary shadow-[inset_2px_0_0_0_var(--brand)]"
            : interactive && "text-fg-secondary hover:bg-surface-overlay/50 hover:text-fg-primary",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            className="shrink-0 rounded p-0.5 hover:bg-surface-overlay"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <ObservationTypeIcon type={o.type} />
        <span className="truncate font-medium">
          {o.name ?? <span className="text-fg-tertiary">(unnamed)</span>}
        </span>
        {o.level && o.level !== "DEFAULT" && <LevelBadge level={o.level} />}
        <span className="tnum ml-auto shrink-0 pl-2 font-mono text-[11px] text-fg-tertiary">
          {formatDuration(o.startTime, o.endTime)}
        </span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <ObservationNode
            key={child.observation.id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

/**
 * Toggle for the noise-omission behaviour of `buildTree`. Active (default)
 * means noise nodes (stage-* spans) are hidden.
 */
export function OmitNoiseToggle({
  omitNoise,
  onChange,
}: {
  omitNoise: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", omitNoise && "bg-brand-subtle text-brand")}
      onClick={() => onChange(!omitNoise)}
      title={omitNoise ? "隐藏噪音节点（stage-*）" : "显示全部节点"}
      aria-pressed={omitNoise}
    >
      <Filter className="h-3.5 w-3.5" />
    </Button>
  );
}
