/** Trace list preview: execution graph with details floating over the graph. */
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  Clock,
  Copy,
  Cpu,
  GitBranch,
  Layers,
  ListTree,
  X,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { LocalIsoDate } from "@/shared/components/local-iso-date";
import { StatChip } from "@/shared/components/observation-detail";
import { ObservationTimelineDialog } from "@/shared/components/observation-timeline";
import { ObservationTraceGraphDialog } from "@/shared/components/observation-trace-graph-dialog";
import { ObservationTraceGraphView } from "@/shared/components/observation-trace-graph-view";
import { toast } from "@/shared/components/toast";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTraceObservationsQuery, useTraceQuery } from "@/shared/hooks/queries";
import { formatLatency, formatTokens } from "@/shared/lib/format";

export function TracePeekView({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const query = useTraceQuery(traceId);
  const trace = query.data;

  const [timelineOpen, setTimelineOpen] = useState(false);
  const [traceGraphOpen, setTraceGraphOpen] = useState(false);
  const observationsQuery = useTraceObservationsQuery(traceId);
  const observations = observationsQuery.data?.pages.flatMap((page) => page.data) ?? [];
  const copyId = () => {
    navigator.clipboard.writeText(traceId);
    toast.success("Trace ID copied");
  };

  const totalTokens = observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0);
  const traceView = trace ? { ...trace, observations } : null;

  return (
    <aside className="flex h-full w-[760px] max-w-[85vw] shrink-0 flex-col border-l border-border bg-surface-raised animate-[spectra-slide-in-right_250ms_cubic-bezier(0.32,0.72,0,1)]">
      {/* Header */}
      <div className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ListTree className="h-4 w-4 shrink-0 text-brand" />
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg-primary">
            {trace?.name ?? (query.isLoading ? "Loading…" : "(unnamed trace)")}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setTraceGraphOpen(true)}>
            <GitBranch className="h-4 w-4" />
            Trace graph
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Timeline"
            onClick={() => setTimelineOpen(true)}
          >
            <ChartNoAxesCombined className="h-4 w-4" />
          </Button>
          <Link to={`/traces/${encodeURIComponent(traceId)}`} title="Open full view">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          </Link>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      {query.isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.error ? (
        <p className="p-4 text-sm text-danger">
          {query.error instanceof Error ? query.error.message : "Failed to load trace"}
        </p>
      ) : trace ? (
        <>
          {/* Compact meta band (full width) */}
          <div className="shrink-0 space-y-1.5 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={copyId}
                className="group flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-overlay/60"
                title="Copy trace ID"
              >
                <span className="font-mono text-xs text-fg-secondary">{trace.id}</span>
                <Copy className="h-3 w-3 text-fg-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
              <span className="text-xs text-fg-tertiary">
                <LocalIsoDate date={new Date(trace.timestamp)} />
                {trace.userId ? ` · user: ${trace.userId}` : ""}
                {trace.sessionId ? ` · session: ${trace.sessionId}` : ""}
              </span>
            </div>

            {(trace.environment || trace.version || trace.release || trace.tags.length > 0) && (
              <div className="flex flex-wrap gap-1.5 px-1">
                {trace.environment && <Badge variant="muted">{trace.environment}</Badge>}
                {trace.version && <Badge variant="outline">v: {trace.version}</Badge>}
                {trace.release && <Badge variant="outline">rel: {trace.release}</Badge>}
                {trace.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatChip icon={Clock} label="Latency" value={formatLatency(trace.latency)} />
              <StatChip
                icon={Layers}
                label="Observations"
                value={
                  trace.observationCount >= 0
                    ? `${observations.length} / ${trace.observationCount}`
                    : String(observations.length)
                }
              />
              <StatChip icon={Cpu} label="Tokens" value={formatTokens(totalTokens)} />
            </div>
          </div>

          {traceView && <ObservationTraceGraphView trace={traceView} />}
        </>
      ) : null}

      {traceView && (
        <ObservationTimelineDialog
          trace={traceView}
          open={timelineOpen}
          onOpenChange={setTimelineOpen}
        />
      )}
      {traceView && (
        <ObservationTraceGraphDialog
          trace={traceView}
          open={traceGraphOpen}
          onOpenChange={setTraceGraphOpen}
        />
      )}
    </aside>
  );
}
