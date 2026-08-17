/**
 * Trace timeline — Chrome DevTools-style waterfall render of an observation
 * tree, shown as a fullscreen dialog.
 *
 * The tree (built with `buildTree`) is re-expressed as a time-aligned
 * waterfall: rows keep the nesting (indent + full-path tooltip), every
 * observation becomes a colored bar positioned by its start/end time, EVENTs
 * collapse into dots, and running observations (no endTime) get a striped
 * tail. A sticky ruler with auto-nice ticks + gridlines, ⌘/Ctrl-wheel zoom,
 * hover tooltips with timing, and a click-to-inspect bottom panel
 * (ObservationDetail) complete the view.
 *
 * Rendering internals (Ruler, TimelineRow, helpers) live in
 * observation-timeline-waterfall.tsx.
 */
import { ChartNoAxesCombined, Frame, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ObservationTypeIcon } from "@/shared/components/observation-badges";
import { ObservationDetail } from "@/shared/components/observation-detail";
import {
  BAR_COLOR_FALLBACK,
  BAR_COLORS,
  flattenTree,
  formatClock,
  NAME_COL_W,
  Ruler,
  TimelineRow,
  ZOOM_MAX,
  ZOOM_MIN,
} from "@/shared/components/observation-timeline-waterfall";
import { buildTree } from "@/shared/components/observation-tree";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/components/ui/dialog";
import { formatMs, formatTokens } from "@/shared/lib/format";
import type { TraceWithDetails } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

/**
 * Full panel (header + waterfall + detail). Mounted only while the dialog is
 * open, so its effects (ResizeObserver, wheel zoom) always find the scroll
 * container on first run.
 */
function TimelinePanel({
  trace,
  onClose,
  omitNoise,
}: {
  trace: TraceWithDetails;
  onClose: () => void;
  omitNoise: boolean;
}) {
  const [pxPerMs, setPxPerMs] = useState<number | null>(null); // null = auto fit
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewW, setViewW] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildTree(trace.observations, { omitNoise }), [trace, omitNoise]);
  const t0 = useMemo(() => {
    const times = trace.observations.map((o) => new Date(o.startTime).getTime());
    return times.length ? Math.min(...times) : new Date(trace.timestamp).getTime();
  }, [trace]);
  const totalMs = useMemo(() => {
    const times = trace.observations.flatMap((o) => {
      const s = new Date(o.startTime).getTime();
      const e = o.endTime ? new Date(o.endTime).getTime() : s;
      return [s, e];
    });
    return Math.max(1, Math.max(...times) - t0);
  }, [trace, t0]);
  const rows = useMemo(() => flattenTree(tree, t0), [tree, t0]);

  const fitPxPerMs = viewW ? Math.max(0.01, (viewW - NAME_COL_W - 96) / totalMs) : null;
  const effective = pxPerMs ?? fitPxPerMs ?? 0.5;
  const selected = selectedId ? (rows.find((r) => r.id === selectedId)?.obs ?? null) : null;
  const selectedScores = selected
    ? trace.scores.filter((s) => s.observationId === selected.id)
    : [];

  const totalTokens = trace.observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0);
  const errorCount = trace.observations.filter((o) => o.level === "ERROR").length;

  // Track the scroll container width for the fit-to-window zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ⌘/Ctrl + wheel zooms (native wheel listeners are passive by default).
  const fitRef = useRef(fitPxPerMs);
  fitRef.current = fitPxPerMs;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setPxPerMs((prev) => {
        const base = prev ?? fitRef.current ?? 0.5;
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, base * (e.deltaY < 0 ? 1.25 : 0.8)));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomPct =
    pxPerMs === null || !fitRef.current ? 100 : Math.round((pxPerMs / fitRef.current) * 100);
  const legendTypes = ["AGENT", "GENERATION", "TOOL", "SPAN", "EVENT"];

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ChartNoAxesCombined className="h-4 w-4 shrink-0 text-brand" />
          <DialogTitle className="text-[15px]">Timeline</DialogTitle>
          <span className="truncate text-sm text-fg-secondary">
            {trace.name ?? "(unnamed trace)"}
          </span>
        </div>

        <div className="hidden items-center gap-3 text-[11px] text-fg-tertiary md:flex">
          <span className="tnum font-mono">{formatMs(totalMs)}</span>
          <span>{rows.length} obs</span>
          {totalTokens > 0 && (
            <span className="tnum font-mono">{formatTokens(totalTokens)} tok</span>
          )}
          {errorCount > 0 && <span className="font-semibold text-danger">{errorCount} error</span>}
        </div>

        <div className="hidden items-center gap-3 lg:flex">
          {legendTypes.map((t) => (
            <span key={t} className="flex items-center gap-1.5 text-[11px] text-fg-secondary">
              <span className={cn("h-2 w-2 rounded-[3px]", BAR_COLORS[t] ?? BAR_COLOR_FALLBACK)} />
              {t}
            </span>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Zoom out"
            onClick={() => setPxPerMs(effective / 1.5)}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Zoom in"
            onClick={() => setPxPerMs(effective * 1.5)}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="tnum h-8 w-14 px-0 text-xs"
            title="Fit to window"
            onClick={() => setPxPerMs(null)}
          >
            {zoomPct}%
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="w-max">
            {/* Ruler row — sticky top; name header sticky left */}
            <div className="sticky top-0 z-30 flex">
              <div
                className="sticky left-0 z-40 flex shrink-0 items-center gap-2 border-b border-r border-line bg-surface-raised px-3 text-[11px] font-medium text-fg-tertiary"
                style={{ width: NAME_COL_W }}
              >
                <Frame className="h-3 w-3" />
                <span className="truncate">Name</span>
                <span className="tnum ml-auto font-mono text-fg-tertiary/80">
                  {formatClock(t0)}
                </span>
              </div>
              <Ruler totalMs={totalMs} pxPerMs={effective} />
            </div>

            {rows.length === 0 ? (
              <p className="px-4 py-8 text-sm text-fg-tertiary">No observations in this trace.</p>
            ) : (
              rows.map((row) => (
                <TimelineRow
                  key={row.id}
                  row={row}
                  totalMs={totalMs}
                  pxPerMs={effective}
                  selected={selectedId === row.id}
                  onSelect={setSelectedId}
                />
              ))
            )}
          </div>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="flex h-[40%] min-h-[300px] shrink-0 flex-col border-t border-line bg-surface-raised">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
              <ObservationTypeIcon type={selected.type} />
              <span className="truncate text-sm font-semibold text-fg-primary">
                {selected.name ?? "(unnamed)"}
              </span>
              <span className="tnum font-mono text-[11px] text-fg-tertiary">
                +{formatMs(new Date(selected.startTime).getTime() - t0)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-7 w-7"
                title="Close detail"
                onClick={() => setSelectedId(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ObservationDetail observation={selected} scores={selectedScores} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ObservationTimelineDialog({
  trace,
  open,
  onOpenChange,
  omitNoise = true,
}: {
  trace: TraceWithDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  omitNoise?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0"
      >
        <TimelinePanel trace={trace} onClose={() => onOpenChange(false)} omitNoise={omitNoise} />
      </DialogContent>
    </Dialog>
  );
}
