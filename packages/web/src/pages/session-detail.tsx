/**
 * Session detail — lite replica of web's session detail view, rendered as a
 * single merged observation tree: every trace in the session contributes its
 * observation subtree (rooted at the trace), with a divider between turns.
 * Mirrors the trace-detail page's tree + detail-panel layout, extended across
 * a whole session. Clicking a trace root collapses/expands its subtree; a
 * dedicated button opens the standalone trace detail page.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, ChevronRight, ListTree, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ObservationDetail } from "@/components/observation-detail";
import { buildTree, ObservationNode } from "@/components/observation-tree";
import { EmptyState, ErrorState } from "@/components/state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { getSession } from "@/lib/api";
import { formatDateTime, formatIntervalSeconds, usdFormatter } from "@/lib/format";
import type { SessionTrace } from "@/lib/types";
import { cn } from "@/lib/utils";

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

/**
 * Turn header: the trace that anchors each observation subtree. Clicking the
 * row collapses/expands the subtree; the arrow button opens the standalone
 * trace detail page.
 */
function TraceRootRow({
  trace,
  expanded,
  onToggle,
}: {
  trace: SessionTrace;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => e.key === "Enter" && onToggle()}
      aria-expanded={expanded}
      className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50"
    >
      <ChevronRight
        className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
      />
      <ListTree className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
      <span className="truncate font-semibold">{trace.name ?? "(unnamed trace)"}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatDateTime(trace.timestamp)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
        {trace.latency !== null && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatIntervalSeconds(trace.latency)}
          </span>
        )}
        <Link
          to={`/traces/${encodeURIComponent(trace.id)}`}
          onClick={(e) => e.stopPropagation()}
          title="Open trace detail"
          aria-label="Open trace detail"
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </span>
    </div>
  );
}

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => getSession(sessionId!),
    enabled: !!sessionId,
  });

  const session = query.data;

  const trees = useMemo(
    () => (session?.traces ?? []).map((t) => buildTree(t.observations)),
    [session],
  );

  // The selected observation and the trace it belongs to (for its scores).
  const selected = useMemo(() => {
    if (!selectedId || !session) return null;
    for (const trace of session.traces) {
      const observation = trace.observations.find((o) => o.id === selectedId);
      if (observation) return { observation, trace };
    }
    return null;
  }, [selectedId, session]);

  const selectedScores = selected
    ? selected.trace.scores.filter((s) => s.observationId === selected.observation.id)
    : [];

  const toggleTrace = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <Link
          to="/sessions"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Sessions
        </Link>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{sessionId}</h1>
            {session && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                Started {formatDateTime(session.createdAt)}
              </p>
            )}
          </div>
        </div>

        {session && (
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Duration" value={formatIntervalSeconds(session.sessionDuration)} />
            <Stat label="Traces" value={session.countTraces} />
            <Stat
              label="Total Cost"
              value={session.totalCost > 0 ? usdFormatter(session.totalCost) : "—"}
            />
            <Stat
              label="Users"
              value={
                session.users.length > 0 ? (
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    {session.users.join(", ")}
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <Stat
              label="Environment"
              value={
                session.environment ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {session.environment}
                  </Badge>
                ) : (
                  "—"
                )
              }
            />
          </div>
        )}
      </div>

      {/* Body: merged observation tree + detail panel */}
      <div className="flex min-h-0 flex-1">
        <Card className="m-4 mr-0 flex w-[45%] min-w-[320px] flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Observation tree</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-2">
            {query.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : query.error ? (
              <ErrorState error={query.error} />
            ) : session && session.traces.length === 0 ? (
              <EmptyState message="No traces in this session." />
            ) : (
              <ScrollArea className="h-full">
                {session?.traces.map((trace, i) => {
                  const isCollapsed = collapsed.has(trace.id);
                  return (
                    <div key={trace.id}>
                      {i > 0 && <Separator className="my-2" />}
                      <TraceRootRow
                        trace={trace}
                        expanded={!isCollapsed}
                        onToggle={() => toggleTrace(trace.id)}
                      />
                      {!isCollapsed &&
                        (trees[i] ?? []).map((node) => (
                          <ObservationNode
                            key={node.observation.id}
                            node={node}
                            depth={1}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                          />
                        ))}
                    </div>
                  );
                })}
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <Card className="m-4 flex flex-1 flex-col overflow-hidden">
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-4 pt-6">
            {selected ? (
              <ObservationDetail observation={selected.observation} scores={selectedScores} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select an observation to view its details.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
