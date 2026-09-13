/**
 * Session detail — lite replica of web's session detail view, rendered as a
 * single merged observation tree: every trace in the session contributes its
 * observation subtree (rooted at the trace), with a divider between turns.
 * Mirrors the trace-detail page's tree + detail-panel layout, extended across
 * a whole session. Clicking a trace root collapses/expands its subtree; a
 * dedicated button opens the standalone trace detail page.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  ListTree,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ObservationDetail } from "@/shared/components/observation-detail";
import { ObservationTimelineDialog } from "@/shared/components/observation-timeline";
import { buildTree, ObservationNode, OmitNoiseToggle } from "@/shared/components/observation-tree";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState } from "@/shared/components/state";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Separator } from "@/shared/components/ui/separator";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useObservationDetailQuery, useTraceObservationsQuery } from "@/shared/hooks/queries";
import { getSession } from "@/shared/lib/api";
import { formatDateTime, formatIntervalSeconds, formatTokens } from "@/shared/lib/format";
import type { Observation, SessionTrace } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

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

function TraceObservations({
  traceId,
  expanded,
  omitNoise,
  selectedId,
  onSelect,
  onLoaded,
}: {
  traceId: string;
  expanded: boolean;
  omitNoise: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoaded: (traceId: string, observations: Observation[]) => void;
}) {
  const query = useTraceObservationsQuery(traceId, expanded);
  const observations = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  const tree = useMemo(() => buildTree(observations, { omitNoise }), [observations, omitNoise]);

  useEffect(() => onLoaded(traceId, observations), [onLoaded, observations, traceId]);

  if (!expanded) return null;
  if (query.isLoading) return <Skeleton className="ml-6 h-20 w-[calc(100%-1.5rem)]" />;
  if (query.error) return <ErrorState error={query.error} />;

  return (
    <>
      {tree.map((node) => (
        <ObservationNode
          key={node.observation.id}
          node={node}
          depth={1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
      {query.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="ml-6 mt-1"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more observations"}
        </Button>
      )}
    </>
  );
}

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPage = Number(searchParams.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return (
    <SessionDetailContent
      key={`${sessionId}:${page}`}
      sessionId={sessionId}
      page={page}
      onPageChange={(next) =>
        setSearchParams((previous) => {
          const params = new URLSearchParams(previous);
          params.set("page", String(next));
          return params;
        })
      }
    />
  );
}

function SessionDetailContent({
  sessionId,
  page,
  onPageChange,
}: {
  sessionId: string | undefined;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedTraceIds, setExpandedTraceIds] = useState<Set<string>>(new Set());
  const [loadedByTrace, setLoadedByTrace] = useState<Map<string, Observation[]>>(new Map());
  const [timelineOpen, setTimelineOpen] = useState(false);

  const query = useQuery({
    queryKey: ["session", sessionId, page],
    queryFn: ({ signal }) => getSession(sessionId!, page, signal),
    enabled: !!sessionId,
    gcTime: 30_000,
  });

  const session = query.data;

  const [omitNoise, setOmitNoise] = useState(true);
  const selectedQuery = useObservationDetailQuery(selectedId);
  const handleLoaded = useMemo(
    () => (traceId: string, observations: Observation[]) => {
      setLoadedByTrace((previous) => {
        if (previous.get(traceId) === observations) return previous;
        const next = new Map(previous);
        next.set(traceId, observations);
        return next;
      });
    },
    [],
  );

  // The selected observation and the trace it belongs to (for its scores).
  const selected = useMemo(() => {
    if (!selectedId || !session) return null;
    for (const trace of session.traces) {
      const observation = loadedByTrace.get(trace.id)?.find((o) => o.id === selectedId);
      if (observation) return { observation, trace };
    }
    return null;
  }, [loadedByTrace, selectedId, session]);

  const selectedScores = selected
    ? selected.trace.scores.filter((s) => s.observationId === selected.observation.id)
    : [];

  const toggleTrace = (id: string) =>
    setExpandedTraceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const sessionView = session
    ? {
        ...session,
        traces: session.traces.map((trace) => ({
          ...trace,
          observations: loadedByTrace.get(trace.id) ?? [],
        })),
      }
    : null;

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
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Started {formatDateTime(session.createdAt)}</span>
                <Badge variant="outline" className="font-normal">
                  Full session · all times and environments
                </Badge>
              </div>
            )}
          </div>
          {session && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => setTimelineOpen(true)}
            >
              <ChartNoAxesCombined className="h-4 w-4" />
              Page timeline
            </Button>
          )}
        </div>

        {session && (
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Duration" value={formatIntervalSeconds(session.sessionDuration)} />
            <Stat label="Traces" value={session.countTraces} />
            <Stat label="Total Tokens" value={formatTokens(session.totalTokens)} />
            <Stat
              label="Users"
              value={
                session.users.length > 0 ? (
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    {session.users.join(", ")}
                    {session.usersTruncated ? ", …" : ""}
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
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">Observation tree</CardTitle>
            <OmitNoiseToggle omitNoise={omitNoise} onChange={setOmitNoise} />
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
                  const expanded = expandedTraceIds.has(trace.id);
                  return (
                    <div key={trace.id}>
                      {i > 0 && <Separator className="my-2" />}
                      <TraceRootRow
                        trace={trace}
                        expanded={expanded}
                        onToggle={() => toggleTrace(trace.id)}
                      />
                      <TraceObservations
                        traceId={trace.id}
                        expanded={expanded}
                        omitNoise={omitNoise}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        onLoaded={handleLoaded}
                      />
                    </div>
                  );
                })}
              </ScrollArea>
            )}
          </CardContent>
          <Pagination meta={session?.meta} page={page} pageSize={50} onPageChange={onPageChange} />
        </Card>

        <Card className="m-4 flex flex-1 flex-col overflow-hidden">
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-4 pt-6">
            {selectedQuery.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : selectedQuery.error ? (
              <ErrorState error={selectedQuery.error} />
            ) : selectedQuery.data && selected ? (
              <ObservationDetail observation={selectedQuery.data} scores={selectedScores} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select an observation to view its details.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {sessionView && (
        <ObservationTimelineDialog
          traces={sessionView.traces}
          open={timelineOpen}
          onOpenChange={setTimelineOpen}
          omitNoise={omitNoise}
        />
      )}
    </div>
  );
}
