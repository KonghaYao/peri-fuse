import { GitBranch, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ObservationDetail } from "@/shared/components/observation-detail";
import { ObservationTraceGraph } from "@/shared/components/observation-trace-graph";
import { ErrorState } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useObservationDetailQuery, useTraceObservationsQuery } from "@/shared/hooks/queries";
import { useTraceGraphObservations } from "@/shared/hooks/use-trace-graph-observations";
import type { TraceWithDetails } from "@/shared/lib/types";

type GraphDialogProps = {
  trace: TraceWithDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function TraceGraphPanel({ trace, onOpenChange }: Omit<GraphDialogProps, "open">) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useObservationDetailQuery(selectedId);
  const query = useTraceObservationsQuery(trace.id);
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  // Complete the existing paged query before laying out the graph so a hidden
  // parent on a later page cannot temporarily place its children on the main lane.
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  const observations = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? trace.observations,
    [query.data, trace.observations],
  );
  const loadingObservations = !isError && (query.isLoading || Boolean(hasNextPage));
  const graph = useTraceGraphObservations(trace.id, observations, !loadingObservations);
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <GitBranch className="h-5 w-5 text-brand" />
        <div className="min-w-0 flex-1">
          <DialogTitle className="text-base">Trace graph</DialogTitle>
          <DialogDescription className="mt-1 truncate text-xs">
            {trace.name ?? trace.id} · Generation and tool calls, ordered by start time
          </DialogDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onOpenChange(false)}
          aria-label="Close graph"
        >
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="min-h-0 flex-1 overflow-auto border-b border-border md:border-r md:border-b-0">
          {graph.isLoading && (
            <p className="px-4 py-2 text-xs text-fg-tertiary">
              Loading branch details and output previews…
            </p>
          )}
          {graph.failures.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-warning">
              <span>Some branch details could not load; background markers may be incomplete.</span>
              <Button variant="ghost" size="sm" onClick={graph.retry}>
                Retry
              </Button>
            </div>
          )}
          {graph.outputFailures.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-warning">
              <span>Some output previews could not load.</span>
              <Button variant="ghost" size="sm" onClick={graph.retry}>
                Retry
              </Button>
            </div>
          )}
          {isError && (
            <div className="p-4">
              <ErrorState error={query.error} />
              <p className="mb-2 text-xs text-fg-tertiary">
                Showing the observations loaded so far.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => (hasNextPage ? fetchNextPage() : query.refetch())}
              >
                Retry loading observations
              </Button>
            </div>
          )}
          {loadingObservations ? (
            <div className="space-y-3 p-4">
              <p className="text-sm text-fg-tertiary">
                Loading trace observations… {observations.length} loaded
              </p>
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <ObservationTraceGraph
              observations={graph.observations}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </section>
        <aside className="min-h-0 overflow-auto p-5 md:w-[38%] md:min-w-[320px]">
          {!selectedId ? (
            <div className="flex h-full min-h-32 items-center justify-center text-sm text-fg-tertiary">
              Select a node to inspect its input, output and metadata.
            </div>
          ) : detail.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : detail.error ? (
            <>
              <ErrorState error={detail.error} />
              <Button variant="outline" onClick={() => detail.refetch()}>
                Retry
              </Button>
            </>
          ) : detail.data ? (
            <ObservationDetail
              observation={detail.data}
              scores={trace.scores.filter((score) => score.observationId === selectedId)}
            />
          ) : null}
        </aside>
      </div>
    </>
  );
}

/** Trace graph dialog shares the existing observation detail cache and paged trace data. */
export function ObservationTraceGraphDialog({ open, ...props }: GraphDialogProps) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent
        hideClose
        className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:rounded-none"
      >
        {open && <TraceGraphPanel key={props.trace.id} {...props} />}
      </DialogContent>
    </Dialog>
  );
}
