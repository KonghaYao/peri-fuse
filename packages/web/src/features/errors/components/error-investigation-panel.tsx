import {
  Badge,
  Button,
  JsonTree,
  Skeleton,
  TableInlineError,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { ArrowUpRight, Route, X } from "lucide-solid";
import { type Component, Show } from "solid-js";
import { useObservationDetailQuery, useTraceQuery } from "@/shared/hooks/queries";
import { formatDateTime } from "@/shared/lib/format";
import type { ErrorEvent, Observation } from "@/shared/lib/types";

function PathNode(props: { label: string; value: string; active?: boolean }) {
  return (
    <div class="min-w-0 rounded-md border border-line bg-surface-inset/60 px-12 py-8">
      <div class="text-[10px] uppercase tracking-[0.08em] text-fg-tertiary">{props.label}</div>
      <div
        class={`mt-2 truncate font-mono text-xs ${props.active ? "text-danger" : "text-fg-primary"}`}
      >
        {props.value}
      </div>
    </div>
  );
}

function ObservationEvidence(props: { observation: Observation }) {
  const payload = () => ({
    input: props.observation.input,
    output: props.observation.output,
    metadata: props.observation.metadata,
    statusMessage: props.observation.statusMessage,
    level: props.observation.level,
    model: props.observation.model,
  });

  return (
    <div class="space-y-12">
      <JsonTree data={payload()} defaultCollapsedDepth={2} />
    </div>
  );
}

export const ErrorInvestigationPanel: Component<{
  error: ErrorEvent;
  onClose: () => void;
}> = (props) => {
  const detailQuery = useObservationDetailQuery(props.error.id);
  const parentQuery = useObservationDetailQuery(props.error.parentObservationId);
  const traceQuery = useTraceQuery(props.error.traceId ?? undefined);

  return (
    <aside class="fixed inset-0 z-40 flex min-h-0 flex-col border-l border-line bg-surface-raised shadow-xl md:static md:z-auto md:w-[min(46vw,580px)] md:shadow-none">
      <div class="flex shrink-0 items-start justify-between gap-12 border-b border-line px-16 py-12">
        <div class="min-w-0">
          <div class="flex items-center gap-8">
            <Badge class="border-danger/25 bg-danger-subtle text-danger">ERROR</Badge>
            <span class="truncate text-sm font-semibold text-fg-primary">
              {props.error.name ?? "Unnamed observation"}
            </span>
          </div>
          <p class="mt-4 line-clamp-8 font-mono text-[11px] leading-4 text-fg-secondary">
            {props.error.statusMessage ?? "No status message recorded"}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={props.onClose} aria-label="Close investigation">
          <X class="h-16 w-16" size={16} />
        </Button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-16">
        <section class="mb-20">
          <div class="mb-8 flex items-center gap-8 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
            <Route class="h-14 w-14" size={14} /> Investigation path
          </div>
          <div class="grid gap-6">
            <PathNode
              label="Trace"
              value={
                traceQuery.data?.name ??
                props.error.traceName ??
                props.error.traceId ??
                "Unknown trace"
              }
            />
            <div class="ml-16 h-8 border-l border-dashed border-line-strong" />
            <PathNode
              label="Direct parent"
              value={
                parentQuery.data?.name ??
                props.error.parentObservationId ??
                "Trace root (no parent)"
              }
            />
            <div class="ml-16 h-8 border-l border-dashed border-danger/40" />
            <PathNode label="Error" value={props.error.name ?? props.error.id} active />
          </div>
          <div class="mt-12 flex flex-wrap items-center gap-12 text-xs text-fg-tertiary">
            <span>{formatDateTime(props.error.startTime)}</span>
            {props.error.model && <span class="font-mono">{props.error.model}</span>}
            {props.error.traceId && (
              <A
                href={`/traces/${encodeURIComponent(props.error.traceId)}`}
                class="inline-flex items-center gap-4 text-brand hover:underline"
              >
                Open full trace <ArrowUpRight class="h-12 w-12" size={12} />
              </A>
            )}
          </div>
        </section>

        <Show
          when={!detailQuery.isPending}
          fallback={
            <div class="space-y-8 py-16">
              <Skeleton class="h-96 w-full" />
              <Skeleton class="h-96 w-full" />
            </div>
          }
        >
          <Show
            when={!detailQuery.isError}
            fallback={<TableInlineError error={detailQuery.error} />}
          >
            <Show when={detailQuery.data}>
              {(observation) => (
                <Tabs defaultValue="error">
                  <TabsList>
                    <TabsTrigger value="error">Error evidence</TabsTrigger>
                    <Show when={props.error.parentObservationId}>
                      <TabsTrigger value="parent">Parent source</TabsTrigger>
                    </Show>
                  </TabsList>
                  <TabsContent value="error" class="mt-16">
                    <ObservationEvidence observation={observation()} />
                  </TabsContent>
                  <Show when={props.error.parentObservationId}>
                    <TabsContent value="parent" class="mt-16">
                      <Show
                        when={!parentQuery.isPending}
                        fallback={
                          <div class="space-y-8 py-16">
                            <Skeleton class="h-96 w-full" />
                          </div>
                        }
                      >
                        <Show
                          when={!parentQuery.isError && parentQuery.data}
                          fallback={
                            parentQuery.isError ? (
                              <TableInlineError error={parentQuery.error} />
                            ) : (
                              <p class="text-sm text-fg-tertiary">
                                Parent observation is unavailable.
                              </p>
                            )
                          }
                        >
                          {(parent) => <ObservationEvidence observation={parent()} />}
                        </Show>
                      </Show>
                    </TabsContent>
                  </Show>
                </Tabs>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </aside>
  );
};
