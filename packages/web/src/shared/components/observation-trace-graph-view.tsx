import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { ObservationTraceGraph } from "@/shared/components/observation-trace-graph";
import { TraceGraphDetails } from "@/shared/components/observation-trace-graph-details";
import { ErrorState } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTraceObservationsQuery } from "@/shared/hooks/queries";
import { useTraceGraphObservations } from "@/shared/hooks/use-trace-graph-observations";
import type { TraceWithDetails } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

/** Shared trace browser for the detail page, list preview and fullscreen graph. */
export function ObservationTraceGraphView({
  trace,
  className,
}: {
  trace: TraceWithDetails;
  className?: string;
}) {
  // Key the selection and scroll container by trace so navigating never shows stale details.
  return <TraceGraphView key={trace.id} trace={trace} className={className} />;
}

function TraceGraphView({ trace, className }: { trace: TraceWithDetails; className?: string }) {
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const query = useTraceObservationsQuery(trace.id);
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  // Load every page before assigning lanes; hidden parents can arrive on later pages.
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  const observations = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? trace.observations,
    [query.data, trace.observations],
  );
  const loadingObservations = !isError && (query.isLoading || Boolean(hasNextPage));
  const graph = useTraceGraphObservations(trace.id, observations, !loadingObservations);
  const select = (id: string | null) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(id);
  };
  return (
    <div className={cn("relative isolate min-h-0 min-w-0 flex-1 overflow-hidden", className)}>
      <DialogPrimitive.Root
        modal={false}
        open={selectedId !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedId(undefined);
        }}
      >
        <div className="h-full overflow-auto">
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
              onSelect={select}
              headerActions={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => select(null)}
                >
                  Trace details
                </Button>
              }
            />
          )}
        </div>
        {selectedId !== undefined && (
          <TraceGraphDetails
            trace={trace}
            selectedId={selectedId}
            restoreFocus={() => returnFocus.current?.focus({ preventScroll: true })}
          />
        )}
      </DialogPrimitive.Root>
    </div>
  );
}
