import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Clock, Coins, Cpu, Layers, ListTree, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IoTabs, ObservationDetail, ScoreList, StatChip } from "@/components/observation-detail";
import { buildTree, ObservationNode } from "@/components/observation-tree";
import { ErrorState, LoadingRows } from "@/components/state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { getTrace } from "@/lib/api";
import { formatCost, formatDateTime, formatLatency, formatTokens } from "@/lib/format";
import type { TraceWithDetails } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function TraceDetailPanel({ trace }: { trace: TraceWithDetails }) {
  return (
    <div className="space-y-4">
      <div className="text-base font-semibold">Trace</div>
      <IoTabs input={trace.input} output={trace.output} metadata={trace.metadata} />
      <Separator />
      <div>
        <h3 className="mb-2 text-sm font-semibold">Scores ({trace.scores.length})</h3>
        <ScoreList scores={trace.scores} />
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

  const query = useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => getTrace(traceId!),
    enabled: Boolean(traceId),
  });

  const tree = useMemo(() => buildTree(query.data?.observations ?? []), [query.data]);

  if (query.isLoading) return <LoadingRows rows={12} />;
  if (query.error) return <ErrorState error={query.error} />;
  const trace = query.data;
  if (!trace) return null;

  const selected = selectedId
    ? (trace.observations.find((o) => o.id === selectedId) ?? null)
    : null;

  const totalTokens = trace.observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0);

  // Scores for the selected observation (trace-level scores shown on Trace).
  const selectedScores = selected
    ? trace.scores.filter((s) => s.observationId === selected.id)
    : [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <Link
          to="/traces"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to traces
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">
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
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatDateTime(trace.timestamp)}
          {trace.userId ? ` · user: ${trace.userId}` : ""}
          {trace.sessionId ? ` · session: ${trace.sessionId}` : ""}
          <span className="ml-2 font-mono">{trace.id}</span>
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <StatChip icon={Clock} label="Latency" value={formatLatency(trace.latency)} />
          <StatChip icon={Coins} label="Cost" value={formatCost(trace.totalCost)} />
          <StatChip icon={Layers} label="Observations" value={String(trace.observations.length)} />
          <StatChip icon={Cpu} label="Tokens" value={formatTokens(totalTokens)} />
          <StatChip icon={Star} label="Scores" value={String(trace.scores.length)} />
        </div>
      </div>

      {/* Body: tree + detail */}
      <div className="flex min-h-0 flex-1">
        <Card className="m-4 mr-0 flex w-[45%] min-w-[320px] flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Observation tree</CardTitle>
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
                  "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm",
                  selectedId === null ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <ListTree className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                <span className="font-medium">{trace.name ?? "trace root"}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
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
                <p className="px-2 py-4 text-sm text-muted-foreground">
                  No observations in this trace.
                </p>
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
