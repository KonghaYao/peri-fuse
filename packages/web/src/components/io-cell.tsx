/**
 * Simplified port of web's IOTableCell (the original depends on
 * CodeJsonViewer/media detection/hover-cards which are too heavy for lite).
 *
 * Renders a single-line truncated JSON preview that expands into the full
 * JsonViewer on click. `variant` tints the cell like the original table:
 * input uses a muted background, output a green tint.
 */
import { useState } from "react";

import { JsonViewer } from "@/components/json-viewer";
import { cn } from "@/lib/utils";

function previewText(io: unknown): string {
  if (io === null || io === undefined) return "";
  if (typeof io === "string") return io;
  try {
    return JSON.stringify(io);
  } catch {
    return String(io);
  }
}

export function IoCell({
  io,
  variant = "neutral",
  maxLength = 200,
  className,
}: {
  io: unknown;
  variant?: "input" | "output" | "neutral";
  maxLength?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (io === null || io === undefined || io === "") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const text = previewText(io);
  const truncated = text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;

  return (
    <div
      className={cn(
        "max-w-[300px] cursor-pointer rounded px-2 py-1 text-xs transition-colors hover:ring-1 hover:ring-ring",
        variant === "input" && "bg-muted/50",
        variant === "output" && "bg-emerald-500/10",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        setExpanded((v) => !v);
      }}
      title={expanded ? undefined : text}
    >
      {expanded ? (
        <div className="max-h-[300px] overflow-auto" onClick={(e) => e.stopPropagation()}>
          <JsonViewer data={io} collapsed={3} />
        </div>
      ) : (
        <div className="overflow-hidden text-nowrap text-ellipsis font-mono">{truncated}</div>
      )}
    </div>
  );
}
