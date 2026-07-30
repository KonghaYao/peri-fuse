/**
 * Trace Peek View — Spectra §8.
 *
 * A wide side panel that pushes the table aside (not an overlay) when a trace
 * row is clicked. It surfaces the observation tree directly (like the full
 * trace-detail page) in a two-pane layout: a compact meta band on top, then
 * the selectable observation tree on the left driving the detail pane on the
 * right (trace-level IO + scores when the root is selected). "Open full view"
 * navigates to the dedicated trace-detail page.
 */
import { ArrowUpRight, Clock, Coins, Copy, Cpu, Layers, ListTree, Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { LocalIsoDate } from "@/shared/components/local-iso-date";
import {
  IoTabs,
  ObservationDetail,
  ScoreList,
  StatChip,
} from "@/shared/components/observation-detail";
import { buildTree, ObservationNode } from "@/shared/components/observation-tree";
import { toast } from "@/shared/components/toast";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Separator } from "@/shared/components/ui/separator";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTraceQuery } from "@/shared/hooks/queries";
import { formatCost, formatLatency, formatTokens } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";

export function TracePeekView({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const query = useTraceQuery(traceId);
  const trace = query.data;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(trace?.observations ?? []), [trace]);

  const copyId = () => {
    navigator.clipboard.writeText(traceId);
    toast.success("Trace ID copied");
  };

  const totalTokens = trace?.observations.reduce((acc, o) => acc + (o.totalTokens || 0), 0) ?? 0;
  const selected = selectedId
    ? (trace?.observations.find((o) => o.id === selectedId) ?? null)
    : null;
  const selectedScores = selected
    ? (trace?.scores.filter((s) => s.observationId === selected.id) ?? [])
    : [];

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

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatChip icon={Clock} label="Latency" value={formatLatency(trace.latency)} />
              <StatChip icon={Coins} label="Cost" value={formatCost(trace.totalCost)} />
              <StatChip
                icon={Layers}
                label="Observations"
                value={String(trace.observations.length)}
              />
              <StatChip icon={Cpu} label="Tokens" value={formatTokens(totalTokens)} />
            </div>
          </div>

          {/* Two panes: tree (left) | detail (right) */}
          <div className="flex min-h-0 flex-1">
            {/* Observation tree */}
            <div className="flex w-[320px] shrink-0 flex-col border-r border-border">
              <div className="flex shrink-0 items-center gap-1.5 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary">
                <ListTree className="h-3.5 w-3.5" />
                Observation tree
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-2 pb-2">
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
                    <span className="truncate font-medium">{trace.name ?? "trace root"}</span>
                    <span className="tnum ml-auto shrink-0 font-mono text-[11px] text-fg-tertiary">
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
                    <p className="px-2 py-4 text-sm text-fg-tertiary">
                      No observations in this trace.
                    </p>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Detail pane — follows the tree selection */}
            <ScrollArea className="min-h-0 min-w-0 flex-1">
              <div className="min-w-0 p-4">
                {selected ? (
                  <ObservationDetail observation={selected} scores={selectedScores} />
                ) : (
                  <div className="space-y-4">
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
                )}
              </div>
            </ScrollArea>
          </div>
        </>
      ) : null}
    </aside>
  );
}
