import { GitBranch, X } from "lucide-react";
import { ObservationTraceGraphView } from "@/shared/components/observation-trace-graph-view";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import type { TraceWithDetails } from "@/shared/lib/types";

type GraphDialogProps = {
  trace: TraceWithDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function TraceGraphPanel({ trace, onOpenChange }: Omit<GraphDialogProps, "open">) {
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
      <ObservationTraceGraphView trace={trace} />
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
