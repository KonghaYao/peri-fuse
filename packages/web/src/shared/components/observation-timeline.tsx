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
import { ChartNoAxesCombined, ChevronRight, Gauge, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ObservationTypeIcon } from "@/shared/components/observation-badges";
import { ObservationDetail } from "@/shared/components/observation-detail";
import {
  BAR_COLOR_FALLBACK,
  BAR_COLORS,
  BandBlock,
  buildDurationOpacity,
  DurationOpacity,
  formatClock,
  isSubagentObservation,
  LABEL_W,
  LANE_H,
  Ruler,
  TimelineBand,
} from "@/shared/components/observation-timeline-band";
import { type BandSegment, layoutTypeLanes } from "@/shared/components/observation-timeline-layout";
import { isNoiseObservation } from "@/shared/components/observation-tree";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/components/ui/dialog";
import { formatMs, formatTokens } from "@/shared/lib/format";
import type { Observation, SessionScore, SessionTrace, TraceWithDetails } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

/** One time-line source: a single trace, or one trace inside a session. */
export type TimelineSource = {
  name: string;
  observations: Observation[];
  scores: SessionScore[];
};

/**
 * Full panel (header + band + detail). Mounted only while the dialog is open,
 * so its ResizeObserver always finds the band container on first run.
 */
function TimelinePanel({
  sources,
  onClose,
  omitNoise,
}: {
  sources: TimelineSource[];
  onClose: () => void;
  omitNoise: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewW, setViewW] = useState(0);
  const [heat, setHeat] = useState(false);
  const bandRef = useRef<HTMLDivElement>(null);

  // All observations across sources share one time axis (min start → max end).
  const allObs = useMemo(() => sources.flatMap((s) => s.observations), [sources]);
  // Source index per observation, for cross-trace hover labels.
  const traceOf = useMemo(() => {
    const map = new Map<string, number>();
    sources.forEach((s, i) => s.observations.forEach((o) => map.set(o.id, i)));
    return map;
  }, [sources]);
  const traceNames = useMemo(() => sources.map((s) => s.name), [sources]);

  // Subagent internals: an AGENT `subagent*` span owns a subtree (its direct
  // and transitive children by parentObservationId). Those observations are
  // kept off the main track — each subagent gets a collapsible section below
  // the band instead, so the hierarchy is visible without clicking anything.
  const subagentTrees = useMemo(() => {
    const children = new Map<string, Observation[]>();
    for (const o of allObs) {
      if (o.parentObservationId) {
        const arr = children.get(o.parentObservationId) ?? [];
        arr.push(o);
        children.set(o.parentObservationId, arr);
      }
    }
    const collect = (id: string): Observation[] =>
      (children.get(id) ?? []).flatMap((k) => [k, ...collect(k.id)]);
    const map = new Map<Observation, Observation[]>();
    for (const o of allObs) {
      if (isSubagentObservation(o)) map.set(o, collect(o.id));
    }
    return map;
  }, [allObs]);
  const subagentMembers = useMemo(() => {
    const set = new Set<string>();
    for (const kids of subagentTrees.values()) for (const k of kids) set.add(k.id);
    return set;
  }, [subagentTrees]);

  // Timeline hides `stage-*` (shared noise rule) plus `tool-batch*` wrappers —
  // the tree keeps tool-batch spans, but on the band they add nothing.
  const observations = useMemo(
    () =>
      allObs.filter(
        (o) =>
          !subagentMembers.has(o.id) &&
          !isSubagentObservation(o) &&
          (!omitNoise || (!isNoiseObservation(o) && !(o.name ?? "").startsWith("tool-batch"))),
      ),
    [allObs, omitNoise, subagentMembers],
  );
  const t0 = useMemo(() => {
    const times = allObs.map((o) => new Date(o.startTime).getTime());
    return times.length ? Math.min(...times) : Date.now();
  }, [allObs]);
  const totalMs = useMemo(() => {
    const times = allObs.flatMap((o) => {
      const s = new Date(o.startTime).getTime();
      const e = o.endTime ? new Date(o.endTime).getTime() : s;
      return [s, e];
    });
    return Math.max(1, Math.max(...times) - t0);
  }, [allObs, t0]);
  const groups = useMemo(
    () => layoutTypeLanes(observations, t0, totalMs, traceOf),
    [observations, t0, totalMs, traceOf],
  );
  const obsCount = groups.reduce((acc, g) => acc + g.segments.length, 0);

  // Heat mode: durations of everything actually visible (main track + every
  // subagent region) drive the opacity mapping. Running observations use
  // their elapsed time.
  const visibleObs = useMemo(
    () => [
      ...observations,
      ...[...subagentTrees.values()].flatMap((kids) => filterBandObservations(kids, omitNoise)),
    ],
    [observations, subagentTrees, omitNoise],
  );
  const durations = useMemo(
    () =>
      visibleObs.map((o) => {
        if (o.endTime) return new Date(o.endTime).getTime() - new Date(o.startTime).getTime();
        return totalMs - (new Date(o.startTime).getTime() - t0); // running: elapsed
      }),
    [visibleObs, totalMs, t0],
  );
  const opacityFor = useMemo(
    () => (heat ? buildDurationOpacity(durations) : undefined),
    [heat, durations],
  );
  // Track the band width for the strict time→pixel mapping.
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The selected observation plus the scores of the source (trace) it lives in.
  const selected = useMemo(() => {
    if (!selectedId) return null;
    for (const s of sources) {
      const obs = s.observations.find((o) => o.id === selectedId);
      if (obs) return { obs, scores: s.scores.filter((sc) => sc.observationId === obs.id) };
    }
    return null;
  }, [selectedId, sources]);

  const totalTokens = allObs.reduce((acc, o) => acc + (o.totalTokens || 0), 0);
  const errorCount = allObs.filter((o) => o.level === "ERROR").length;
  const legendTypes = ["AGENT", "GENERATION", "TOOL", "SPAN", "EVENT"];

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="z-10 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-background px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ChartNoAxesCombined className="h-4 w-4 shrink-0 text-brand" />
          <DialogTitle className="text-[15px]">Timeline</DialogTitle>
          <span className="truncate text-sm text-fg-secondary">
            {sources.length === 1 ? sources[0].name : `${sources.length} traces in session`}
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

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant={heat ? "default" : "ghost"}
            size="sm"
            className="h-8 gap-1.5 px-2.5"
            title="Color by duration — longer observations render deeper"
            aria-pressed={heat}
            onClick={() => setHeat((h) => !h)}
          >
            <Gauge className="h-4 w-4" />
            Heat
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

      {/* Band — one fixed-width rectangle, strict time proportion */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div ref={bandRef} className="mx-auto w-full max-w-[1100px]">
          <Ruler
            totalMs={totalMs}
            pxPerMs={viewW > LABEL_W ? (viewW - LABEL_W) / totalMs : 0}
            width={viewW}
          />
          {groups.length === 0 && subagentTrees.size === 0 ? (
            <p className="px-4 py-8 text-sm text-fg-tertiary">No observations in this trace.</p>
          ) : (
            groups.length > 0 && (
              <TimelineBand
                groups={groups}
                totalMs={totalMs}
                width={viewW}
                opacityFor={opacityFor}
                traceNames={traceNames}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )
          )}

          {/* Subagent branches — same time axis, one collapsible branch per
              subagent below the main track; nested subagents recurse. */}
          {[...subagentTrees.entries()].map(([subagent, kids]) => (
            <SubagentBranch
              key={subagent.id}
              subagent={subagent}
              kids={kids}
              omitNoise={omitNoise}
              t0={t0}
              totalMs={totalMs}
              pxPerMs={viewW > LABEL_W ? (viewW - LABEL_W) / totalMs : 0}
              width={viewW}
              opacityFor={opacityFor}
              traceNames={traceNames}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="flex h-[40%] min-h-[300px] shrink-0 flex-col border-t border-line bg-surface-raised">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
            <ObservationTypeIcon type={selected.obs.type} />
            <span className="truncate text-sm font-semibold text-fg-primary">
              {selected.obs.name ?? "(unnamed)"}
            </span>
            <span className="tnum font-mono text-[11px] text-fg-tertiary">
              +{formatMs(new Date(selected.obs.startTime).getTime() - t0)}
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
            <ObservationDetail observation={selected.obs} scores={selected.scores} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ObservationTimelineDialog({
  trace,
  traces,
  open,
  onOpenChange,
  omitNoise = true,
}: {
  trace?: TraceWithDetails;
  traces?: SessionTrace[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  omitNoise?: boolean;
}) {
  // A session timeline merges every trace of the session into one time axis.
  const sources = useMemo<TimelineSource[]>(() => {
    if (traces) {
      return traces.map((t) => ({
        name: t.name ?? t.id,
        observations: t.observations,
        scores: t.scores,
      }));
    }
    if (trace) {
      return [
        {
          name: trace.name ?? "(unnamed trace)",
          observations: trace.observations,
          scores: trace.scores,
        },
      ];
    }
    return [];
  }, [trace, traces]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0"
      >
        <TimelinePanel
          sources={sources}
          onClose={() => onOpenChange(false)}
          omitNoise={omitNoise}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared band filter: `stage-*` (noise) plus `tool-batch*` wrappers, applied
 * to the main track and every subagent region alike. The tree view keeps
 * tool-batch spans; the band does not.
 */
function filterBandObservations(obsList: Observation[], omitNoise: boolean): Observation[] {
  if (!omitNoise) return obsList;
  return obsList.filter((o) => !isNoiseObservation(o) && !(o.name ?? "").startsWith("tool-batch"));
}

/**
 * One subagent branch: an anchor block (time-aligned with the main track) plus
 * its own track region below, indented and connected by a vertical line. The
 * subtree's own subagents recurse, so the whole hierarchy lives in one picture
 * with a shared time axis.
 */
function SubagentBranch({
  subagent,
  kids,
  omitNoise,
  t0,
  totalMs,
  pxPerMs,
  width,
  opacityFor,
  traceNames,
  traceOf,
  selectedId,
  onSelect,
}: {
  subagent: Observation;
  kids: Observation[];
  omitNoise: boolean;
  t0: number;
  totalMs: number;
  pxPerMs: number;
  width: number;
  opacityFor?: DurationOpacity;
  traceNames?: string[];
  traceOf?: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const regionObs = useMemo(() => filterBandObservations(kids, omitNoise), [kids, omitNoise]);
  const nested = useMemo(() => regionObs.filter((o) => isSubagentObservation(o)), [regionObs]);
  const trackObs = useMemo(() => regionObs.filter((o) => !isSubagentObservation(o)), [regionObs]);
  const groups = useMemo(
    () => layoutTypeLanes(trackObs, t0, totalMs, traceOf),
    [trackObs, t0, totalMs, traceOf],
  );

  // Subtree of a nested subagent, restricted to this region's observations.
  const nestedKids = useMemo(() => {
    const children = new Map<string, Observation[]>();
    for (const o of kids) {
      if (o.parentObservationId) {
        const arr = children.get(o.parentObservationId) ?? [];
        arr.push(o);
        children.set(o.parentObservationId, arr);
      }
    }
    const collect = (id: string): Observation[] =>
      (children.get(id) ?? []).flatMap((k) => [k, ...collect(k.id)]);
    return (sa: Observation) => collect(sa.id);
  }, [kids]);

  const startMs = new Date(subagent.startTime).getTime() - t0;
  const endMs = subagent.endTime ? new Date(subagent.endTime).getTime() - t0 : totalMs;
  const seg: BandSegment = {
    id: subagent.id,
    obs: subagent,
    startMs,
    endMs,
    running: !subagent.endTime,
    lane: 0,
    traceIndex: traceOf?.get(subagent.id),
  };

  return (
    <div className="mt-5">
      {/* Anchor row: the subagent block itself, on the shared time axis */}
      <div className="relative" style={{ height: LANE_H }}>
        <BandBlock
          seg={seg}
          top={4}
          pxPerMs={pxPerMs}
          hovered={hoverId === subagent.id}
          selected={selectedId === subagent.id}
          onHover={setHoverId}
          onSelect={onSelect}
        />
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-0 top-1/2 h-6 w-6 -translate-y-1/2"
          title={collapsed ? "Expand subagent" : "Collapse subagent"}
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronRight
            className={cn("h-3.5 w-3.5 transition-transform", collapsed ? "" : "rotate-90")}
          />
        </Button>
      </div>

      {/* Region: the subtree's tracks, indented and connected to the anchor */}
      {!collapsed && regionObs.length > 0 && (
        <div className="ml-6 mt-1 border-l border-line pl-3">
          {groups.length > 0 && (
            <TimelineBand
              groups={groups}
              totalMs={totalMs}
              width={width}
              opacityFor={opacityFor}
              traceNames={traceNames}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          )}
          {nested.map((sa) => (
            <SubagentBranch
              key={sa.id}
              subagent={sa}
              kids={nestedKids(sa)}
              omitNoise={omitNoise}
              t0={t0}
              totalMs={totalMs}
              pxPerMs={pxPerMs}
              width={width}
              opacityFor={opacityFor}
              traceNames={traceNames}
              traceOf={traceOf}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
