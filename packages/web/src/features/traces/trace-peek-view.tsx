import {
  Badge,
  Button,
  InlineNotice,
  LoadingState,
  LocalIsoDate,
  message,
  ScrollArea,
  Skeleton,
} from "@peri/ui";
import { A } from "@solidjs/router";
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  Clock,
  Copy,
  Cpu,
  Layers,
  ListTree,
  Star,
  X,
} from "lucide-solid";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { ObservationTimelineDialog } from "@/shared/components/observations/observation-timeline-dialog";
import { StatChip } from "@/shared/components/observations/stat-chip";
import {
  TraceObservationDetailPane,
  TraceObservationTreePane,
  useTraceObservationState,
} from "@/shared/components/observations/trace-observation-workspace";
import { formatLatency, formatTokens } from "@/shared/lib/format";

export const TracePeekView: Component<{
  traceId: string;
  onClose: () => void;
}> = (props) => {
  const [timelineOpen, setTimelineOpen] = createSignal(false);
  const state = useTraceObservationState(props.traceId);
  const trace = () => state.trace();
  const totalTokens = createMemo(() =>
    state.observations().reduce((acc, observation) => acc + (observation.totalTokens || 0), 0),
  );

  const copyId = async () => {
    await navigator.clipboard.writeText(props.traceId);
    message.success("Trace ID copied");
  };

  return (
    <aside class="flex h-full w-[760px] max-w-[85vw] shrink-0 flex-col border-l border-border bg-surface-raised animate-[spectra-slide-in-right_250ms_cubic-bezier(0.32,0.72,0,1)]">
      <div class="flex h-[60px] shrink-0 items-center justify-between gap-8 border-b border-border px-16">
        <div class="flex min-w-0 items-center gap-8">
          <ListTree class="h-16 w-16 shrink-0 text-brand" size={16} />
          <h2 class="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg-primary">
            {trace()?.name ?? (state.traceQuery.isPending ? "Loading…" : "(unnamed trace)")}
          </h2>
        </div>
        <div class="flex shrink-0 items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            class="h-32 w-32 p-0"
            title="Timeline"
            onClick={() => setTimelineOpen(true)}
          >
            <ChartNoAxesCombined class="h-16 w-16" size={16} />
          </Button>
          <A href={`/traces/${encodeURIComponent(props.traceId)}`} title="Open full view">
            <Button variant="ghost" size="sm" class="h-32 w-32 p-0">
              <ArrowUpRight class="h-16 w-16" size={16} />
            </Button>
          </A>
          <Button
            variant="ghost"
            size="sm"
            class="h-32 w-32 p-0"
            onClick={props.onClose}
            title="Close"
          >
            <X class="h-16 w-16" size={16} />
          </Button>
        </div>
      </div>

      <Show
        when={!state.traceQuery.isPending}
        fallback={
          <div class="space-y-12 p-16">
            <Skeleton class="h-20 w-2/3" />
            <Skeleton class="h-16 w-1/2" />
            <Skeleton class="h-80 w-full" />
            <Skeleton class="h-160 w-full" />
          </div>
        }
      >
        <Show
          when={!state.traceQuery.isError && trace()}
          fallback={
            <InlineNotice tone="danger" role="alert" class="m-16">
              {state.traceQuery.error instanceof Error
                ? state.traceQuery.error.message
                : "Failed to load trace"}
            </InlineNotice>
          }
        >
          {(currentTrace) => (
            <>
              <div class="shrink-0 space-y-6 border-b border-border px-16 py-10">
                <div class="flex flex-wrap items-center gap-x-12 gap-y-4">
                  <button
                    type="button"
                    onClick={() => void copyId()}
                    class="group flex items-center gap-6 rounded-md px-4 py-2 transition-colors hover:bg-surface-overlay/60"
                    title="Copy trace ID"
                  >
                    <span class="font-mono text-xs text-fg-secondary">{currentTrace().id}</span>
                    <Copy
                      class="h-12 w-12 text-fg-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                      size={12}
                    />
                  </button>
                  <span class="text-xs text-fg-tertiary">
                    <LocalIsoDate date={new Date(currentTrace().timestamp)} />
                    {currentTrace().userId ? ` · user: ${currentTrace().userId}` : ""}
                    {currentTrace().sessionId ? ` · session: ${currentTrace().sessionId}` : ""}
                  </span>
                </div>

                <Show
                  when={
                    currentTrace().environment ||
                    currentTrace().version ||
                    currentTrace().release ||
                    currentTrace().tags.length > 0
                  }
                >
                  <div class="flex flex-wrap gap-6 px-4">
                    <Show when={currentTrace().environment}>
                      {(value) => <Badge tone="neutral">{value()}</Badge>}
                    </Show>
                    <Show when={currentTrace().version}>
                      {(value) => <Badge tone="neutral">v: {value()}</Badge>}
                    </Show>
                    <Show when={currentTrace().release}>
                      {(value) => <Badge tone="neutral">rel: {value()}</Badge>}
                    </Show>
                    <For each={currentTrace().tags}>
                      {(tag) => <Badge tone="neutral">{tag}</Badge>}
                    </For>
                  </div>
                </Show>

                <div class="grid grid-cols-2 gap-8 sm:grid-cols-3">
                  <StatChip
                    icon={Clock}
                    label="Latency"
                    value={formatLatency(currentTrace().latency)}
                  />
                  <StatChip
                    icon={Layers}
                    label="Observations"
                    value={
                      currentTrace().observationCount >= 0
                        ? `${state.observations().length} / ${currentTrace().observationCount}`
                        : String(state.observations().length)
                    }
                  />
                  <StatChip icon={Cpu} label="Tokens" value={formatTokens(totalTokens())} />
                </div>
              </div>

              <div class="flex min-h-0 flex-1">
                <div class="flex w-[320px] shrink-0 flex-col border-r border-border">
                  <div class="flex shrink-0 items-center gap-6 px-16 py-8 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary">
                    <ListTree class="h-14 w-14" size={14} />
                    Observation tree
                  </div>
                  <ScrollArea class="min-h-0 flex-1">
                    <Show
                      when={!state.observationsQuery.isPending}
                      fallback={<LoadingState label="Loading observations…" class="p-32" />}
                    >
                      <TraceObservationTreePane
                        compact
                        traceName={currentTrace().name}
                        traceLatency={currentTrace().latency}
                        flatObservations={state.flatObservations()}
                        selectedId={state.selectedId}
                        onSelect={state.setSelectedId}
                        omitNoise={state.omitNoise}
                        onOmitNoiseChange={state.setOmitNoise}
                        observationsQuery={state.observationsQuery}
                      />
                    </Show>
                  </ScrollArea>
                </div>

                <ScrollArea class="min-h-0 min-w-0 flex-1">
                  <div class="min-w-0 p-16">
                    <TraceObservationDetailPane
                      selectedId={state.selectedId}
                      selectedQuery={state.selectedQuery}
                      selected={state.selected}
                      selectedScores={state.selectedScores}
                      traceIoQuery={state.traceIoQuery}
                      traceView={state.traceView}
                    />
                  </div>
                </ScrollArea>
              </div>

              <Show when={state.traceView()}>
                {(traceView) => (
                  <ObservationTimelineDialog
                    trace={traceView()}
                    open={timelineOpen()}
                    onOpenChange={setTimelineOpen}
                    omitNoise={state.omitNoise()}
                  />
                )}
              </Show>
            </>
          )}
        </Show>
      </Show>
    </aside>
  );
};
