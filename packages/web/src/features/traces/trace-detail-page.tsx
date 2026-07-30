/**
 * Trace detail page — Spectra §8.
 *
 * Full-page view of a single trace: a compact header (back link, title,
 * badges, copy-id, key stats) above a two-pane body — the observation tree on
 * the left driving the detail panel on the right. Reached from the trace peek
 * view's "Open full view" action or a direct URL.
 */
import { ArrowLeft, Clock, Coins, Copy, Cpu, Layers, ListTree, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LocalIsoDate } from "@/shared/components/local-iso-date";
import {
  IoTabs,
  ObservationDetail,
  ScoreList,
  StatChip,
} from "@/shared/components/observation-detail";
import { buildTree, ObservationNode } from "@/shared/components/observation-tree";
import { ErrorState } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Separator } from "@/shared/components/ui/separator";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTraceQuery } from "@/shared/hooks/queries";
import { formatCost, formatLatency, formatTokens } from "@/shared/lib/format";
import type { TraceWithDetails } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

// ---------------------------------------------------------------------------
// Detail panel (trace-level: IO + scores)
// ---------------------------------------------------------------------------

function TraceDetailPanel({ trace }: { trace: TraceWithDetails }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-base font-semibold text-fg-primary">
        <ListTree className="h-4 w-4 text-brand" />
        Trace
      </div>
      <IoTabs input={trace.input} output={trace.output} metadata={trace.metadata} />
      <Separator />
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
          <Star className="h-3.5 w-3.5 text-fg-tertiary" />
          Scores ({trace.scores.length})
        </h3>
        <ScoreList scores={trace.scores} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — mirrors the page shape (header + two panes)
// ---------------------------------------------------------------------------

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
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <Skeleton className="w-[45%]" />
        <Skeleton className="flex-1" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useTraceQuery(traceId);
  const trace = query.data;

  const tree = useMemo(() => buildTree(trace?.observations ?? []), [trace]);

  if (query.isLoading) return <TraceDetailSkeleton />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!trace) return null;

  const selected = selectedId
    ? (trace.observations.find((o) => o.id === selectedId) ?? null)
    : null;

  const totalTokens = trace.observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0);

  // Scores for the selected observation (trace-level scores shown on Trace).
  const selectedScores = selected
    ? trace.scores.filter((s) => s.observationId === selected.id)
    : [];

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
          <StatChip icon={Coins} label="Cost" value={formatCost(trace.totalCost)} />
          <StatChip icon={Layers} label="Observations" value={String(trace.observations.length)} />
          <StatChip icon={Cpu} label="Tokens" value={formatTokens(totalTokens)} />
          <StatChip icon={Star} label="Scores" value={String(trace.scores.length)} />
        </div>
      </div>

      {/* Body: observation tree + detail */}
      <div className="flex min-h-0 flex-1">
        <Card className="m-4 mr-0 flex w-[45%] min-w-[320px] flex-col overflow-hidden">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm text-fg-primary">Observation tree</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-2">
            <ScrollArea className="h-full">
              {/* Virtual root representing the trace itself */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(null)}
                onKeyDown={(e) => e.key === "Enter" && setSelectedId(null)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                  selectedId === null
                    ? "bg-brand-subtle text-fg-primary shadow-[inset_2px_0_0_0_var(--brand)]"
                    : "text-fg-secondary hover:bg-surface-overlay/50 hover:text-fg-primary",
                )}
              >
                <ListTree className="h-3.5 w-3.5 shrink-0 text-brand" />
                <span className="font-medium">{trace.name ?? "trace root"}</span>
                <span className="tnum ml-auto font-mono text-[11px] text-fg-tertiary">
                  {formatLatency(trace.latency)}
                </span>
              </div>
              {tree.map((node) => (
                <ObservationNode
                  key={node.observation.id}
                  node={node}
                  depth={1}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ))}
              {tree.length === 0 && (
                <p className="px-2 py-4 text-sm text-fg-tertiary">No observations in this trace.</p>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="m-4 flex flex-1 flex-col overflow-hidden">
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-4 pt-6">
            {selected ? (
              <ObservationDetail observation={selected} scores={selectedScores} />
            ) : (
              <TraceDetailPanel trace={trace} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
