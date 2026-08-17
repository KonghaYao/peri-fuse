/**
 * Waterfall internals for the trace timeline dialog — ruler ticks, per-row
 * bars, and shared helpers. Split from observation-timeline.tsx so neither
 * file exceeds the 500-line budget.
 */
import { useState } from "react";
import { LevelBadge, ObservationTypeIcon } from "@/shared/components/observation-badges";
import type { TreeNode } from "@/shared/components/observation-tree";
import { formatDuration, formatMs, formatTokens } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

export const NAME_COL_W = 300; // px, width of the sticky name column
const TICK_TARGET_PX = 90; // target px between ruler labels
export const ZOOM_MIN = 0.002; // px per ms
export const ZOOM_MAX = 60;

export const BAR_COLORS: Record<string, string> = {
  SPAN: "bg-blue-500/70 dark:bg-blue-400/60",
  EVENT: "bg-green-500/80 dark:bg-green-400/70",
  GENERATION: "bg-fuchsia-500/70 dark:bg-fuchsia-400/60",
  AGENT: "bg-purple-500/70 dark:bg-purple-400/60",
  TOOL: "bg-orange-500/70 dark:bg-orange-400/60",
  CHAIN: "bg-pink-500/70 dark:bg-pink-400/60",
  RETRIEVER: "bg-teal-500/70 dark:bg-teal-400/60",
  EVALUATOR: "bg-indigo-500/70 dark:bg-indigo-400/60",
  EMBEDDING: "bg-amber-500/70 dark:bg-amber-400/60",
  GUARDRAIL: "bg-red-500/70 dark:bg-red-400/60",
};
export const BAR_COLOR_FALLBACK = "bg-slate-400/60 dark:bg-slate-400/50";

export type TimelineRowData = {
  id: string;
  obs: Observation;
  depth: number;
  path: string; // ancestor chain, used as the row tooltip
  startMs: number; // offset from trace start
  endMs: number | null; // null = still running at trace end
};

/** Pick a "nice" step (1/2/5 × 10^n) ≥ targetMs for the ruler ticks. */
function niceTickStep(targetMs: number): number {
  const base = 10 ** Math.floor(Math.log10(targetMs));
  for (const m of [1, 2, 5, 10]) {
    if (base * m >= targetMs) return base * m;
  }
  return base * 10;
}

/** Compact relative-time label for a ruler tick. */
function formatTickLabel(ms: number, stepMs: number): string {
  if (stepMs < 1000) return `${ms} ms`;
  if (stepMs < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
  return formatMs(ms);
}

/** HH:MM:SS.mmm local clock for the trace start. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** DFS-flatten the tree into rows, tracking depth and ancestor path. */
export function flattenTree(roots: TreeNode[], t0: number): TimelineRowData[] {
  const rows: TimelineRowData[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentPath: string) => {
    for (const n of nodes) {
      const o = n.observation;
      const name = o.name ?? "(unnamed)";
      const path = parentPath ? `${parentPath} / ${name}` : name;
      rows.push({
        id: o.id,
        obs: o,
        depth,
        path,
        startMs: new Date(o.startTime).getTime() - t0,
        endMs: o.endTime ? new Date(o.endTime).getTime() - t0 : null,
      });
      walk(n.children, depth + 1, path);
    }
  };
  walk(roots, 0, "");
  return rows;
}

// ---------------------------------------------------------------------------
// Ruler — sticky tick bar above the waterfall
// ---------------------------------------------------------------------------

export function Ruler({ totalMs, pxPerMs }: { totalMs: number; pxPerMs: number }) {
  const stepMs = niceTickStep(TICK_TARGET_PX / pxPerMs);
  const stepPx = stepMs * pxPerMs;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += stepMs) ticks.push(t);
  const labelEvery = Math.max(1, Math.ceil(55 / stepPx)); // avoid label overlap

  return (
    <div
      className="relative h-7 shrink-0 overflow-hidden border-b border-line bg-surface-raised"
      style={{ width: totalMs * pxPerMs + 96 }}
    >
      {ticks.map((t, i) => (
        <div
          key={t}
          className={cn(
            "absolute bottom-0 border-l",
            i % 5 === 0 ? "h-2.5 border-line-strong" : "h-1.5 border-line",
          )}
          style={{ left: t * pxPerMs }}
        >
          {i % labelEvery === 0 && (
            <span className="tnum absolute left-1.5 top-0.5 whitespace-nowrap font-mono text-[10px] text-fg-tertiary">
              {formatTickLabel(t, stepMs)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row — name cell + waterfall bar
// ---------------------------------------------------------------------------

export function TimelineRow({
  row,
  totalMs,
  pxPerMs,
  selected,
  onSelect,
}: {
  row: TimelineRowData;
  totalMs: number;
  pxPerMs: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const [tipX, setTipX] = useState<number | null>(null);
  const { obs } = row;

  const barLeft = row.startMs * pxPerMs;
  const barEnd = (row.endMs ?? totalMs) * pxPerMs;
  const barW = Math.max(3, barEnd - barLeft);
  const isDot = barW < 5; // near-instant: EVENTs & co
  const color = BAR_COLORS[obs.type] ?? BAR_COLOR_FALLBACK;

  const stepMs = niceTickStep(TICK_TARGET_PX / pxPerMs);
  const stepPx = stepMs * pxPerMs;
  const subPx = stepPx / 5;
  const gridBg = {
    backgroundImage: [
      subPx >= 4 &&
        `repeating-linear-gradient(to right, var(--line-default) 0 1px, transparent 1px ${subPx}px)`,
      `repeating-linear-gradient(to right, var(--line-strong) 0 1px, transparent 1px ${stepPx}px)`,
    ]
      .filter(Boolean)
      .join(","),
  };

  const tokenText = obs.totalTokens > 0 ? formatTokens(obs.totalTokens) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(row.id)}
      className={cn(
        "group flex h-7 cursor-pointer items-stretch border-b border-line/40 text-sm outline-none",
        "hover:bg-surface-overlay/50 focus-visible:bg-surface-overlay/50",
        selected && "bg-brand-subtle hover:bg-brand-subtle",
      )}
    >
      {/* Name cell — sticky while the timeline scrolls horizontally */}
      <div
        title={row.path}
        className={cn(
          "sticky left-0 z-20 flex w-[300px] shrink-0 items-center gap-1.5 border-r border-line/60 bg-surface-raised px-2 group-hover:bg-surface-overlay/50",
          selected &&
            "bg-brand-subtle shadow-[inset_2px_0_0_0_var(--brand)] group-hover:bg-brand-subtle",
        )}
        style={{ width: NAME_COL_W, paddingLeft: 10 + row.depth * 14 }}
      >
        {row.depth > 0 && <span className="h-px w-3 shrink-0 bg-line-strong" />}
        <ObservationTypeIcon type={obs.type} className="shrink-0" />
        <span
          className={cn(
            "truncate font-medium",
            obs.level === "ERROR" && "text-danger",
            obs.level === "WARNING" && "text-warning",
          )}
        >
          {obs.name ?? "(unnamed)"}
        </span>
        {obs.level && obs.level !== "DEFAULT" && (
          <span className="ml-auto shrink-0 pl-2">
            <LevelBadge level={obs.level} />
          </span>
        )}
      </div>

      {/* Waterfall cell */}
      <div
        className="relative"
        style={{ width: totalMs * pxPerMs + 96 }}
        onMouseMove={(e) => setTipX(e.nativeEvent.offsetX)}
        onMouseLeave={() => setTipX(null)}
      >
        <div className="absolute inset-0" style={gridBg} />
        {isDot ? (
          <span
            className={cn(
              "absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background",
              color,
            )}
            style={{ left: barLeft }}
          />
        ) : (
          <div
            className={cn(
              "absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[3px] shadow-sm",
              color,
              selected && "ring-2 ring-brand",
              row.endMs === null &&
                "opacity-90 [background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.35)_0_4px,transparent_4px_8px)]",
            )}
            style={{ left: barLeft, width: barW }}
          />
        )}

        {/* Hover tooltip */}
        {tipX !== null && (
          <div
            className="pointer-events-none absolute z-50 w-56 -translate-y-full rounded-md border border-line bg-popover p-2 text-xs shadow-lg"
            style={{
              left: Math.min(Math.max(tipX + 12, 8), totalMs * pxPerMs + 96 - 232),
              top: -10,
            }}
          >
            <div className="flex items-center gap-1.5">
              <ObservationTypeIcon type={obs.type} />
              <span className="truncate font-medium text-fg-primary">
                {obs.name ?? "(unnamed)"}
              </span>
            </div>
            <div className="tnum mt-1 flex justify-between font-mono text-[11px] text-fg-secondary">
              <span>+{formatMs(row.startMs)}</span>
              <span>{formatDuration(obs.startTime, obs.endTime)}</span>
            </div>
            {(tokenText || (obs.level && obs.level !== "DEFAULT")) && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-tertiary">
                {tokenText && <span className="tnum font-mono">{tokenText} tok</span>}
                {obs.level && obs.level !== "DEFAULT" && <LevelBadge level={obs.level} />}
              </div>
            )}
            {obs.statusMessage && (
              <p className="mt-0.5 line-clamp-2 text-[11px] text-danger">{obs.statusMessage}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
