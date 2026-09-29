import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Star, X } from "lucide-react";
import { IoTabs, ObservationDetail, ScoreList } from "@/shared/components/observation-detail";
import { ErrorState } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import { Separator } from "@/shared/components/ui/separator";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useObservationDetailQuery, useTraceIoQuery } from "@/shared/hooks/queries";
import type { TraceWithDetails } from "@/shared/lib/types";

/** Non-modal, container-local details keep the graph's width and scroll position intact. */
export function TraceGraphDetails({
  trace,
  selectedId,
  restoreFocus,
}: {
  trace: TraceWithDetails;
  selectedId: string | null;
  restoreFocus: () => void;
}) {
  const observation = useObservationDetailQuery(selectedId);
  const traceIo = useTraceIoQuery(trace.id, selectedId === null);
  const query = selectedId === null ? traceIo : observation;
  return (
    <DialogPrimitive.Content
      className="absolute inset-y-0 right-0 z-20 flex w-[80%] min-w-0 flex-col border-l border-line bg-surface-raised shadow-[-12px_0_32px_rgb(0_0_0/0.14)] outline-none motion-safe:animate-[spectra-slide-in-right_180ms_ease-out]"
      onInteractOutside={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreFocus();
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-primary">
          {selectedId === null
            ? "Trace details"
            : (observation.data?.name ?? "Observation details")}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">
          Input, output, metadata and scores for the selected item.
        </DialogPrimitive.Description>
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close details">
            <X className="h-4 w-4" />
          </Button>
        </DialogPrimitive.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {query.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : query.error ? (
          <div className="space-y-3">
            <ErrorState error={query.error} />
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry loading details
            </Button>
          </div>
        ) : selectedId === null ? (
          <div className="space-y-4">
            <p className="break-words text-sm text-fg-secondary">{trace.name ?? trace.id}</p>
            <IoTabs
              input={traceIo.data?.input}
              output={traceIo.data?.output}
              metadata={traceIo.data?.metadata}
            />
            <Separator />
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
              <Star className="h-3.5 w-3.5 text-fg-tertiary" /> Scores ({trace.scores.length})
            </h3>
            <ScoreList scores={trace.scores} />
          </div>
        ) : observation.data ? (
          <ObservationDetail
            key={selectedId}
            observation={observation.data}
            scores={trace.scores.filter((score) => score.observationId === selectedId)}
          />
        ) : null}
      </div>
    </DialogPrimitive.Content>
  );
}
