import {
  Badge,
  Button,
  InlineNotice,
  LoadingState,
  LocalIsoDate,
  message,
  Skeleton,
  StatChip,
} from "@peri/ui";
import { A, useParams } from "@solidjs/router";
import { ArrowLeft, ChartNoAxesCombined, Clock, Copy, Cpu, Layers, Star } from "lucide-solid";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { ObservationTimelineDialog } from "@/shared/components/observations/observation-timeline-dialog";
import { TraceObservationWorkspace } from "@/shared/components/observations/trace-observation-workspace";
import { useTraceObservationsQuery, useTraceQuery } from "@/shared/hooks/queries";
import { formatLatency, formatTokens } from "@/shared/lib/format";

const TraceDetailSkeleton: Component = () => (
  <div class="flex h-full flex-col">
    <div class="space-y-12 border-b border-border px-24 py-16">
      <Skeleton class="h-12 w-96" />
      <Skeleton class="h-24 w-1/3" />
      <Skeleton class="h-12 w-1/2" />
      <div class="flex gap-8">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton class="h-48 w-128" data-index={index} />
        ))}
      </div>
    </div>
    <div class="flex min-h-0 flex-1">
      <Skeleton class="w-[45%] rounded-none" />
      <Skeleton class="flex-1 rounded-none" />
    </div>
  </div>
);

export const TraceDetailPage: Component = () => {
  const params = useParams<{ traceId: string }>();
  const traceId = () => params.traceId;
  const [timelineOpen, setTimelineOpen] = createSignal(false);

  const traceQuery = useTraceQuery(traceId());
  const observationsQuery = useTraceObservationsQuery(traceId());
  const observations = createMemo(
    () => observationsQuery.data?.pages.flatMap((page) => page.data) ?? [],
  );
  const trace = () => traceQuery.data;

  const totalTokens = createMemo(() =>
    observations().reduce((acc, observation) => acc + (observation.totalTokens || 0), 0),
  );

  const traceView = createMemo(() => {
    const shell = trace();
    if (!shell) return null;
    return { ...shell, observations: observations() };
  });

  const copyId = async () => {
    const current = trace();
    if (!current) return;
    await navigator.clipboard.writeText(current.id);
    message.success("Trace ID copied");
  };

  return (
    <Show when={!traceQuery.isPending} fallback={<TraceDetailSkeleton />}>
      <Show
        when={!traceQuery.isError && trace()}
        fallback={
          <InlineNotice tone="danger" role="alert" class="m-24">
            {traceQuery.error instanceof Error ? traceQuery.error.message : "Failed to load trace"}
          </InlineNotice>
        }
      >
        {(currentTrace) => (
          <div class="flex h-full flex-col">
            <div class="shrink-0 border-b border-border px-24 py-16">
              <A
                href="/traces"
                class="mb-8 inline-flex items-center gap-4 text-xs text-fg-tertiary transition-colors hover:text-fg-primary"
              >
                <ArrowLeft class="h-14 w-14" size={14} />
                Back to traces
              </A>

              <div class="flex flex-wrap items-center gap-8">
                <h1 class="text-lg font-semibold tracking-[-0.02em] text-fg-primary">
                  {currentTrace().name ?? "(unnamed trace)"}
                </h1>
                <Show when={currentTrace().environment}>
                  {(value) => <Badge tone="neutral">{value()}</Badge>}
                </Show>
                <Show when={currentTrace().version}>
                  {(value) => <Badge tone="neutral">v: {value()}</Badge>}
                </Show>
                <Show when={currentTrace().release}>
                  {(value) => <Badge tone="neutral">rel: {value()}</Badge>}
                </Show>
                <For each={currentTrace().tags}>{(tag) => <Badge tone="neutral">{tag}</Badge>}</For>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-28 w-28 p-0"
                  onClick={() => void copyId()}
                  title="Copy trace ID"
                >
                  <Copy class="h-14 w-14" size={14} />
                </Button>
              </div>

              <p class="mt-4 text-xs text-fg-tertiary">
                <LocalIsoDate date={new Date(currentTrace().timestamp)} />
                {currentTrace().userId ? ` · user: ${currentTrace().userId}` : ""}
                {currentTrace().sessionId ? ` · session: ${currentTrace().sessionId}` : ""}
                <span class="ml-8 font-mono text-fg-secondary">{currentTrace().id}</span>
              </p>

              <div class="mt-12 flex flex-wrap gap-8">
                <StatChip
                  icon={<Clock size={14} />}
                  label="Latency"
                  value={formatLatency(currentTrace().latency)}
                />
                <StatChip
                  icon={<Layers size={14} />}
                  label="Observations"
                  value={
                    currentTrace().observationCount >= 0
                      ? `${observations().length} / ${currentTrace().observationCount}`
                      : String(observations().length)
                  }
                />
                <StatChip icon={<Cpu size={14} />} label="Tokens" value={formatTokens(totalTokens())} />
                <StatChip
                  icon={<Star size={14} />}
                  label="Scores"
                  value={String(currentTrace().scores.length)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  class="h-44 self-end"
                  onClick={() => setTimelineOpen(true)}
                >
                  <ChartNoAxesCombined class="h-14 w-14" size={14} />
                  Timeline
                </Button>
              </div>
            </div>

            <div class="flex min-h-0 flex-1">
              <Show
                when={traceId()}
                fallback={<LoadingState label="Loading trace…" class="justify-center flex-1" />}
              >
                {(id) => <TraceObservationWorkspace traceId={id()} class="min-h-0 flex-1" />}
              </Show>
            </div>

            <Show when={traceView()}>
              {(view) => (
                <ObservationTimelineDialog
                  trace={view()}
                  open={timelineOpen()}
                  onOpenChange={setTimelineOpen}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
};
