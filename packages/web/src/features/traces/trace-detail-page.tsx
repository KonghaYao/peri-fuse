/** Trace detail page: full-width execution graph with floating item details. */
import {
  ArrowLeft,
  ChartNoAxesCombined,
  Clock,
  Copy,
  Cpu,
  GitBranch,
  Layers,
  Star,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LocalIsoDate } from "@/shared/components/local-iso-date";
import { StatChip } from "@/shared/components/observation-detail";
import { ObservationTimelineDialog } from "@/shared/components/observation-timeline";
import { ObservationTraceGraphDialog } from "@/shared/components/observation-trace-graph-dialog";
import { ObservationTraceGraphView } from "@/shared/components/observation-trace-graph-view";
import { ErrorState } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTraceObservationsQuery, useTraceQuery } from "@/shared/hooks/queries";
import { formatLatency, formatTokens } from "@/shared/lib/format";

function TraceDetailSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b border-border px-6 py-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-32" />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 p-4">
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [traceGraphOpen, setTraceGraphOpen] = useState(false);

  const query = useTraceQuery(traceId);
  const trace = query.data;
  const observationsQuery = useTraceObservationsQuery(traceId);
  const observations = observationsQuery.data?.pages.flatMap((page) => page.data) ?? [];
  if (query.isLoading) return <TraceDetailSkeleton />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!trace) return null;

  const totalTokens = observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0);
  const traceView = { ...trace, observations };

  const copyId = () => {
    navigator.clipboard.writeText(trace.id);
    toast.success("Trace ID copied");
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 py-4">
        <Link
          to="/traces"
          className="mb-2 inline-flex items-center gap-1 text-xs text-fg-tertiary transition-colors hover:text-fg-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to traces
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-fg-primary">
            {trace.name ?? "(unnamed trace)"}
          </h1>
          {trace.environment && <Badge variant="muted">{trace.environment}</Badge>}
          {trace.version && <Badge variant="outline">v: {trace.version}</Badge>}
          {trace.release && <Badge variant="outline">rel: {trace.release}</Badge>}
          {trace.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={copyId}
            title="Copy trace ID"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>

        <p className="mt-1 text-xs text-fg-tertiary">
          <LocalIsoDate date={new Date(trace.timestamp)} />
          {trace.userId ? ` · user: ${trace.userId}` : ""}
          {trace.sessionId ? ` · session: ${trace.sessionId}` : ""}
          <span className="ml-2 font-mono text-fg-secondary">{trace.id}</span>
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
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
          <StatChip icon={Star} label="Scores" value={String(trace.scores.length)} />
          <Button
            variant="outline"
            size="sm"
            className="h-11 self-end"
            onClick={() => setTraceGraphOpen(true)}
          >
            <GitBranch className="h-3.5 w-3.5" />
            Trace graph
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-11 self-end"
            onClick={() => setTimelineOpen(true)}
          >
            <ChartNoAxesCombined className="h-3.5 w-3.5" />
            Timeline
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 p-4">
        <ObservationTraceGraphView trace={traceView} className="rounded-lg border border-line" />
      </div>

      <ObservationTimelineDialog
        trace={traceView}
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
      />
      <ObservationTraceGraphDialog
        trace={traceView}
        open={traceGraphOpen}
        onOpenChange={setTraceGraphOpen}
      />
    </div>
  );
}
