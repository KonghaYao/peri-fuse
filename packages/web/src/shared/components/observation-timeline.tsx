/**
 * Trace timeline — a single fixed-width time band: every observation becomes
 * a colored block sized strictly by its duration, overlapping observations
 * stack into lanes (so the whole trace fits one rectangle, no horizontal
 * scrolling). Hover floats a detail card over the block; click opens the
 * ObservationDetail panel below the band.
 *
 * Rendering internals (lane layout, ruler, blocks, hover card) live in
 * observation-timeline-band.tsx.
 */
import { ChartNoAxesCombined, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ObservationDetail } from "@/shared/components/observation-detail";
import { ObservationTypeIcon } from "@/shared/components/observation-badges";
import {
  BAR_COLOR_FALLBACK,
  BAR_COLORS,
  formatClock,
  LABEL_W,
  layoutTypeLanes,
  Ruler,
  TimelineBand,
} from "@/shared/components/observation-timeline-band";
import { isNoiseObservation } from "@/shared/components/observation-tree";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/components/ui/dialog";
import { formatMs, formatTokens } from "@/shared/lib/format";
import type { TraceWithDetails } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

/**
 * Full panel (header + band + detail). Mounted only while the dialog is open,
 * so its ResizeObserver always finds the band container on first run.
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewW, setViewW] = useState(0);
  const bandRef = useRef<HTMLDivElement>(null);

  // Timeline hides `stage-*` (shared noise rule) plus `tool-batch*` wrappers —
  // the tree keeps tool-batch spans, but on the band they add nothing.
  const observations = useMemo(
    () =>
      trace.observations.filter(
        (o) => !omitNoise || (!isNoiseObservation(o) && !(o.name ?? "").startsWith("tool-batch")),
      ),
    [trace, omitNoise],
  );
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
  const groups = useMemo(
    () => layoutTypeLanes(observations, t0, totalMs),
    [observations, t0, totalMs],
  );
  const obsCount = groups.reduce((acc, g) => acc + g.segments.length, 0);

  // Track the band width for the strict time→pixel mapping.
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const selected = selectedId
    ? (trace.observations.find((o) => o.id === selectedId) ?? null)
    : null;
  const selectedScores = selected
    ? trace.scores.filter((s) => s.observationId === selected.id)
    : [];

  const totalTokens = trace.observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0);
  const errorCount = trace.observations.filter((o) => o.level === "ERROR").length;
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
          <span>{obsCount} obs</span>
          {totalTokens > 0 && (
            <span className="tnum font-mono">{formatTokens(totalTokens)} tok</span>
          )}
          {errorCount > 0 && <span className="font-semibold text-danger">{errorCount} error</span>}
          <span className="tnum font-mono">{formatClock(t0)}</span>
        </div>

        <div className="hidden items-center gap-3 lg:flex">
          {legendTypes.map((t) => (
            <span key={t} className="flex items-center gap-1.5 text-[11px] text-fg-secondary">
              <span className={cn("h-2 w-2 rounded-[3px]", BAR_COLORS[t] ?? BAR_COLOR_FALLBACK)} />
              {t}
            </span>
          ))}
        </div>

        <div className="ml-auto shrink-0">
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

      {/* Band — one fixed-width rectangle, strict time proportion */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div ref={bandRef} className="mx-auto w-full max-w-[1100px]">
          <Ruler
            totalMs={totalMs}
            pxPerMs={viewW > LABEL_W ? (viewW - LABEL_W) / totalMs : 0}
            width={viewW}
          />
          {groups.length === 0 ? (
            <p className="px-4 py-8 text-sm text-fg-tertiary">No observations in this trace.</p>
          ) : (
            <TimelineBand
              groups={groups}
              totalMs={totalMs}
              width={viewW}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
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
