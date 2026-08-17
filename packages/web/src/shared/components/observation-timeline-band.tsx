/**
 * Timeline band internals for the trace timeline dialog — lane layout,
 * ruler ticks, per-segment blocks, and the hover card. Split from
 * observation-timeline.tsx so neither file exceeds the 500-line budget.
 */
import { useState } from "react";
import { LevelBadge, ObservationTypeIcon } from "@/shared/components/observation-badges";
import { formatDuration, formatMs, formatTokens } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

export const LANE_H = 26; // px per lane row
const BLOCK_H = 18; // px, block height inside a lane
const TICK_TARGET_PX = 90; // target px between ruler labels
const GROUP_GAP = 8; // px between type tracks
export const LABEL_W = 64; // px, type-track label column

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

export type BandSegment = {
  id: string;
  obs: Observation;
  startMs: number; // offset from trace start
  endMs: number; // offset; === totalMs while still running
  running: boolean;
  lane: number;
};

/**
 * Greedy interval-graph coloring: observations sorted by start time take the
 * first lane whose current occupant has already finished (laneEnd <= start),
 * otherwise a new lane opens. Overlapping observations stack vertically, so
 * a single fixed-width band can show concurrent activity.
 */
export function layoutLanes(
  observations: Observation[],
  t0: number,
  totalMs: number,
): BandSegment[] {
  const items = observations
    .map((o) => {
      const startMs = new Date(o.startTime).getTime() - t0;
      const endMs = o.endTime ? new Date(o.endTime).getTime() - t0 : null;
      // EVENTS and zero-duration observations are instants (a thin line), not
      // running spans — a missing endTime on EVENT means "point in time".
      const isInstant = o.type === "EVENT" || (endMs !== null && endMs <= startMs);
      return {
        id: o.id,
        obs: o,
        startMs,
        endMs: isInstant ? startMs : (endMs ?? totalMs),
        running: !isInstant && endMs === null,
        lane: 0,
      };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const laneEnds: number[] = [];
  for (const it of items) {
    let lane = laneEnds.findIndex((end) => end <= it.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = it.endMs;
    it.lane = lane;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Type tracks — one row per observation type (gen / tool / span / ...),
// concurrent observations of the same type stack into lanes within the row.
// ---------------------------------------------------------------------------

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

export type TypeLaneGroup = {
  type: string;
  segments: BandSegment[];
  laneCount: number;
};

/** Group observations by type, each type becoming a track of its own. */
export function layoutTypeLanes(
  observations: Observation[],
  t0: number,
  totalMs: number,
): TypeLaneGroup[] {
  const byType = new Map<string, Observation[]>();
  for (const o of observations) {
    const arr = byType.get(o.type) ?? [];
    arr.push(o);
    byType.set(o.type, arr);
  }
  const groups: TypeLaneGroup[] = [];
  const pushGroup = (type: string) => {
    const obs = byType.get(type);
    if (!obs || obs.length === 0) return;
    const segments = layoutLanes(obs, t0, totalMs);
    const laneCount = segments.reduce((m, s) => Math.max(m, s.lane + 1), 0);
    groups.push({ type, segments, laneCount });
  };
  for (const t of TYPE_ORDER) pushGroup(t);
  for (const t of byType.keys()) {
    if (!TYPE_ORDER.includes(t)) pushGroup(t); // unknown types appended last
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Ruler — tick bar above the band
// ---------------------------------------------------------------------------

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

export function Ruler({
  totalMs,
  pxPerMs,
  width,
}: {
  totalMs: number;
  pxPerMs: number;
  width: number;
}) {
  if (pxPerMs <= 0) return <div className="h-6 shrink-0" />;
  const stepMs = niceTickStep(TICK_TARGET_PX / pxPerMs);
  const stepPx = stepMs * pxPerMs;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += stepMs) ticks.push(t);
  const labelEvery = Math.max(1, Math.ceil(55 / stepPx)); // avoid label overlap

  return (
    <div className="relative h-6 shrink-0 select-none border-b border-line" style={{ width }}>
      <div className="absolute inset-y-0 left-0 border-r border-line" style={{ width: LABEL_W }} />
      {ticks.map((t, i) => (
        <div
          key={t}
          className={cn(
            "absolute bottom-0 border-l",
            i % 5 === 0 ? "h-2.5 border-line-strong" : "h-1.5 border-line",
          )}
          style={{ left: LABEL_W + t * pxPerMs }}
        >
          {i % labelEvery === 0 && (
            <span className="tnum absolute left-1.5 top-0 whitespace-nowrap font-mono text-[10px] text-fg-tertiary">
              {formatTickLabel(t, stepMs)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Band — the fixed-width rectangle holding one block per observation
// ---------------------------------------------------------------------------

export function TimelineBand({
  groups,
  totalMs,
  width,
  selectedId,
  onSelect,
}: {
  groups: TypeLaneGroup[];
  totalMs: number;
  width: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const timeW = Math.max(0, width - LABEL_W);
  const pxPerMs = timeW > 0 ? timeW / totalMs : 0;

  // Position each track (type row); lanes are global within a track.
  let cursor = 0;
  const placed = groups.map((g) => {
    const topPx = cursor;
    cursor += g.laneCount * LANE_H + GROUP_GAP;
    return { ...g, topPx };
  });
  const totalHeight = Math.max(0, cursor - GROUP_GAP);

  const hovered = (() => {
    if (!hoverId) return null;
    for (const g of placed) {
      const seg = g.segments.find((s) => s.id === hoverId);
      if (seg) {
        return {
          seg,
          leftPx: LABEL_W + seg.startMs * pxPerMs,
          topPx: g.topPx + seg.lane * LANE_H,
        };
      }
    }
    return null;
  })();

  // Light vertical gridlines matching the ruler ticks (time area only).
  const gridBg = pxPerMs > 0
    ? {
        backgroundImage: `repeating-linear-gradient(to right, var(--line-default) 0 1px, transparent 1px ${
          niceTickStep(TICK_TARGET_PX / pxPerMs) * pxPerMs
        }px)`,
      }
    : undefined;

  return (
    <div className="relative" style={{ width, height: totalHeight }}>
      <div className="absolute inset-y-0" style={{ left: LABEL_W, right: 0, ...gridBg }} />
      {placed.map((g) => (
        <div
          key={g.type}
          className="group absolute inset-x-0"
          style={{ top: g.topPx, height: g.laneCount * LANE_H }}
        >
          {/* Track hover highlight */}
          <div className="pointer-events-none absolute inset-0 rounded-sm bg-fg-primary/5 opacity-0 transition-opacity group-hover:opacity-100" />
          {/* Track label */}
          <div
            className="absolute inset-y-0 left-0 flex items-center gap-1.5 border-r border-line pr-2"
            style={{ width: LABEL_W }}
          >
            <span
              className={cn("h-2 w-2 shrink-0 rounded-[3px]", BAR_COLORS[g.type] ?? BAR_COLOR_FALLBACK)}
            />
            <span className="truncate text-[10px] font-semibold uppercase text-fg-secondary">
              {g.type}
            </span>
          </div>
          {g.segments.map((seg) => (
            <BandBlock
              key={seg.id}
              seg={seg}
              top={seg.lane * LANE_H + 4} /* relative to the track row */
              pxPerMs={pxPerMs}
              hovered={hoverId === seg.id}
              selected={selectedId === seg.id}
              onHover={setHoverId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
      {hovered && pxPerMs > 0 && (
        <HoverCard
          seg={hovered.seg}
          left={hovered.leftPx}
          top={hovered.topPx}
          width={width}
        />
      )}
    </div>
  );
}

function BandBlock({
  seg,
  top,
  pxPerMs,
  hovered,
  selected,
  onHover,
  onSelect,
}: {
  seg: BandSegment;
  top: number;
  pxPerMs: number;
  hovered: boolean;
  selected: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const { obs } = seg;
  // Zero-duration observations (EVENT etc.) are instants: render a thin
  // vertical line spanning the lane instead of a block.
  const isInstant = seg.endMs <= seg.startMs;
  const left = LABEL_W + seg.startMs * pxPerMs;
  const w = isInstant ? 2 : Math.max(2, (seg.endMs - seg.startMs) * pxPerMs);
  const h = isInstant ? LANE_H : BLOCK_H;
  const topY = isInstant ? top - 4 : top; // undo the block's vertical inset
  const color = BAR_COLORS[obs.type] ?? BAR_COLOR_FALLBACK;
  const showName = !isInstant && w >= 64; // only wide blocks carry an inline label

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(seg.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(seg.id)}
      onMouseEnter={() => onHover(seg.id)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "absolute cursor-pointer outline-none",
        isInstant ? "rounded-none shadow-none" : "rounded-[4px] shadow-sm",
        color,
        (hovered || selected) && "ring-2 ring-brand",
        seg.running &&
          !isInstant &&
          "opacity-90 [background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.35)_0_4px,transparent_4px_8px)]",
        "focus-visible:ring-2 focus-visible:ring-brand",
      )}
      style={{ left, width: w, top: topY, height: h }}
    >
      {showName && (
        <span className="block truncate px-1.5 text-[10px] font-medium leading-[18px] text-white/90">
          {obs.name ?? "(unnamed)"}
        </span>
      )}
    </div>
  );
}

/** Floating card shown above a hovered block. */
function HoverCard({
  seg,
  left,
  top,
  width,
}: {
  seg: BandSegment;
  left: number;
  top: number;
  width: number;
}) {
  const { obs } = seg;
  const tokenText = obs.totalTokens > 0 ? formatTokens(obs.totalTokens) : null;
  return (
    <div
      className="pointer-events-none absolute z-50 w-56 -translate-y-full rounded-md border border-line bg-popover p-2 text-xs shadow-lg"
      style={{ left: Math.min(Math.max(left + 8, 8), width - 232), top: top - 6 }}
    >
      <div className="flex items-center gap-1.5">
        <ObservationTypeIcon type={obs.type} />
        <span className="truncate font-medium text-fg-primary">
          {obs.name ?? "(unnamed)"}
        </span>
      </div>
      <div className="tnum mt-1 flex justify-between font-mono text-[11px] text-fg-secondary">
        <span>+{formatMs(seg.startMs)}</span>
        <span>{seg.running ? "running…" : formatDuration(obs.startTime, obs.endTime!)}</span>
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
  );
}
