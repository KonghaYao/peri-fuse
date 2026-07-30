/**
 * Trace Peek View — Spectra §8.
 *
 * A 480px side panel that pushes the table aside (not an overlay) when a
 * trace row is clicked, showing a rich at-a-glance summary. "Open full view"
 * navigates to the dedicated trace-detail page for the observation tree.
 */
import { ArrowUpRight, Clock, Coins, Copy, Cpu, Layers, ListTree, Star, X } from "lucide-react";
import { Link } from "react-router-dom";

import { LocalIsoDate } from "@/shared/components/local-iso-date";
import { IoTabs, ScoreList, StatChip } from "@/shared/components/observation-detail";
import { toast } from "@/shared/components/toast";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Separator } from "@/shared/components/ui/separator";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTraceQuery } from "@/shared/hooks/queries";
import { formatCost, formatLatency, formatTokens } from "@/shared/lib/format";

export function TracePeekView({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const query = useTraceQuery(traceId);
  const trace = query.data;

  const copyId = () => {
    navigator.clipboard.writeText(traceId);
    toast.success("Trace ID copied");
  };

  const totalTokens = trace?.observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0) ?? 0;

  return (
    <aside className="flex h-full w-[480px] shrink-0 flex-col border-l border-border bg-surface-raised animate-[spectra-slide-in-right_250ms_cubic-bezier(0.32,0.72,0,1)]">
      {/* Header */}
      <div className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ListTree className="h-4 w-4 shrink-0 text-brand" />
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg-primary">
            {trace?.name ?? (query.isLoading ? "Loading…" : "(unnamed trace)")}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {query.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : query.error ? (
            <p className="text-sm text-danger">
              {query.error instanceof Error ? query.error.message : "Failed to load trace"}
            </p>
          ) : trace ? (
            <>
              {/* ID + timestamp */}
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={copyId}
                  className="group flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-overlay/60"
                  title="Copy trace ID"
                >
                  <span className="font-mono text-xs text-fg-secondary">{trace.id}</span>
                  <Copy className="h-3 w-3 text-fg-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
                <p className="px-1 text-xs text-fg-tertiary">
                  <LocalIsoDate date={new Date(trace.timestamp)} />
                  {trace.userId ? ` · user: ${trace.userId}` : ""}
                  {trace.sessionId ? ` · session: ${trace.sessionId}` : ""}
                </p>
              </div>

              {/* Badges */}
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

              {/* Stats */}
              <div className="grid grid-cols-2 gap-2">
                <StatChip icon={Clock} label="Latency" value={formatLatency(trace.latency)} />
                <StatChip icon={Coins} label="Cost" value={formatCost(trace.totalCost)} />
                <StatChip
                  icon={Layers}
                  label="Observations"
                  value={String(trace.observations.length)}
                />
                <StatChip icon={Cpu} label="Tokens" value={formatTokens(totalTokens)} />
              </div>

              <Separator />

              {/* IO */}
              <IoTabs input={trace.input} output={trace.output} metadata={trace.metadata} />

              <Separator />

              {/* Scores */}
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
                  <Star className="h-3.5 w-3.5 text-fg-tertiary" />
                  Scores ({trace.scores.length})
                </h3>
                <ScoreList scores={trace.scores} />
              </div>
            </>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}
