import { ArrowUpRight, LoaderCircle, Route, X } from "lucide-react";
import { Link } from "react-router-dom";
import { ObservationDetail } from "@/shared/components/observation-detail";
import { ErrorState } from "@/shared/components/state";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { useObservationDetailQuery, useTraceQuery } from "@/shared/hooks/queries";
import { formatDateTime } from "@/shared/lib/format";
import type { ErrorEvent } from "@/shared/lib/types";

function PathNode({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface-inset/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-fg-tertiary">{label}</div>
      <div
        className={`mt-0.5 truncate font-mono text-xs ${active ? "text-danger" : "text-fg-primary"}`}
      >
        {value}
      </div>
    </div>
  );
}

export function ErrorInvestigationPanel({
  error,
  onClose,
}: {
  error: ErrorEvent;
  onClose: () => void;
}) {
  const detailQuery = useObservationDetailQuery(error.id);
  const parentQuery = useObservationDetailQuery(error.parentObservationId);
  const traceQuery = useTraceQuery(error.traceId ?? undefined);

  return (
    <aside className="fixed inset-0 z-40 flex min-h-0 flex-col border-l border-line bg-surface-raised shadow-xl md:static md:z-auto md:w-[min(46vw,580px)] md:shadow-none">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge className="border-danger/25 bg-danger-subtle text-danger">ERROR</Badge>
            <span className="truncate text-sm font-semibold text-fg-primary">
              {error.name ?? "Unnamed observation"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-4 text-fg-secondary">
            {error.statusMessage ?? "No status message recorded"}
          </p>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close investigation">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="mb-5">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
            <Route className="h-3.5 w-3.5" /> Investigation path
          </div>
          <div className="grid gap-1.5">
            <PathNode
              label="Trace"
              value={traceQuery.data?.name ?? error.traceName ?? error.traceId ?? "Unknown trace"}
            />
            <div className="ml-4 h-2 border-l border-dashed border-line-strong" />
            <PathNode
              label="Direct parent"
              value={
                parentQuery.data?.name ?? error.parentObservationId ?? "Trace root (no parent)"
              }
            />
            <div className="ml-4 h-2 border-l border-dashed border-danger/40" />
            <PathNode label="Error" value={error.name ?? error.id} active />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-tertiary">
            <span>{formatDateTime(error.startTime)}</span>
            {error.model && <span className="font-mono">{error.model}</span>}
            {error.traceId && (
              <Link
                to={`/traces/${encodeURIComponent(error.traceId)}`}
                className="inline-flex items-center gap-1 text-brand hover:underline"
              >
                Open full trace <ArrowUpRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        </section>

        {detailQuery.isLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-fg-tertiary">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading error evidence…
          </div>
        ) : detailQuery.error ? (
          <ErrorState error={detailQuery.error} />
        ) : detailQuery.data ? (
          <Tabs defaultValue="error">
            <TabsList>
              <TabsTrigger value="error">Error evidence</TabsTrigger>
              {error.parentObservationId && <TabsTrigger value="parent">Parent source</TabsTrigger>}
            </TabsList>
            <TabsContent value="error" className="mt-4">
              <ObservationDetail observation={detailQuery.data} scores={[]} />
            </TabsContent>
            {error.parentObservationId && (
              <TabsContent value="parent" className="mt-4">
                {parentQuery.isLoading ? (
                  <div className="flex items-center gap-2 py-10 text-sm text-fg-tertiary">
                    <LoaderCircle className="h-4 w-4 animate-spin" /> Loading parent evidence…
                  </div>
                ) : parentQuery.error ? (
                  <ErrorState error={parentQuery.error} />
                ) : parentQuery.data ? (
                  <ObservationDetail observation={parentQuery.data} scores={[]} />
                ) : (
                  <p className="text-sm text-fg-tertiary">Parent observation is unavailable.</p>
                )}
              </TabsContent>
            )}
          </Tabs>
        ) : null}
      </div>
    </aside>
  );
}
