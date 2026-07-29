/**
 * Observation tree — shared by the trace-detail page (selectable, drives the
 * detail panel) and the session-detail page (read-only, one merged tree per
 * session with a divider between traces).
 */

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  LevelBadge,
  ObservationTypeBadge,
  ObservationTypeIcon,
} from "@/components/observation-badges";
import { formatDuration } from "@/lib/format";
import type { Observation } from "@/lib/types";
import { cn } from "@/lib/utils";

export type TreeNode = {
  observation: Observation;
  children: TreeNode[];
};

/**
 * Builds a forest from the flat observation list using parentObservationId.
 * Children are sorted by startTime; observations whose parent is missing
 * (e.g. filtered out) are treated as roots.
 */
export function buildTree(observations: Observation[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const o of observations) {
    nodes.set(o.id, { observation: o, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.observation.parentObservationId;
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
          isSelected ? "bg-accent text-accent-foreground" : interactive && "hover:bg-accent/50",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            className="shrink-0 rounded p-0.5 hover:bg-muted"
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
          {o.name ?? <span className="text-muted-foreground">(unnamed)</span>}
        </span>
        <ObservationTypeBadge type={o.type} />
        {o.level && o.level !== "DEFAULT" && <LevelBadge level={o.level} />}
        <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-muted-foreground">
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
