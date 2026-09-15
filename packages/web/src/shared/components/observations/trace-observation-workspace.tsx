import {
  Button,
  InlineNotice,
  LoadingState,
  MonitorTraceTurnTree,
  MonitorTraceTurnTreeShell,
  Skeleton,
} from "@peri/ui";
import { type Component, createMemo, createSignal, type JSX, Show } from "solid-js";
import {
  toFlatObservations,
  toScoreSummary,
} from "@/shared/components/observations/observation-adapters";
import {
  ObservationDetailPanel,
  TraceDetailPanel,
} from "@/shared/components/observations/observation-detail-panel";
import {
  useObservationDetailQuery,
  useTraceIoQuery,
  useTraceObservationsQuery,
  useTraceQuery,
} from "@/shared/hooks/queries";
import { formatLatency } from "@/shared/lib/format";
import type { Observation, TraceWithDetails } from "@/shared/lib/types";

export type TraceObservationWorkspaceProps = {
  traceId: string;
  class?: string;
};

export function useTraceObservationState(traceId: string) {
  const [selectedId, setSelectedId] = createSignal<string | null | undefined>(undefined);
  const [omitNoise, setOmitNoise] = createSignal(true);

  const traceQuery = useTraceQuery(traceId);
  const observationsQuery = useTraceObservationsQuery(traceId);
  const observations = createMemo(
    () => observationsQuery.data?.pages.flatMap((page) => page.data) ?? [],
  );
  const flatObservations = createMemo(() => toFlatObservations(observations()));
  const traceIoQuery = useTraceIoQuery(traceId, selectedId() === null);
  const selectedQuery = useObservationDetailQuery(
    typeof selectedId() === "string" ? selectedId() : null,
  );

  const trace = () => traceQuery.data;
  const selected = () => selectedQuery.data ?? null;
  const selectedScores = createMemo(() => {
    const obs = selected();
    const shell = trace();
    if (!obs || !shell) return [];
    return shell.scores.filter((score) => score.observationId === obs.id).map(toScoreSummary);
  });
  const traceView = createMemo<TraceWithDetails | null>(() => {
    const shell = trace();
    if (!shell) return null;
    return {
      ...shell,
      input: traceIoQuery.data?.input,
      output: traceIoQuery.data?.output,
      metadata: traceIoQuery.data?.metadata,
      observations: observations(),
    };
  });

  return {
    selectedId,
    setSelectedId,
    omitNoise,
    setOmitNoise,
    traceQuery,
    observationsQuery,
    observations,
    flatObservations,
    traceIoQuery,
    selectedQuery,
    trace,
    selected,
    selectedScores,
    traceView,
  };
}

export const TraceObservationTreePane: Component<{
  traceName: string | null | undefined;
  traceLatency: number | null | undefined;
  flatObservations: ReturnType<typeof toFlatObservations>;
  selectedId: () => string | null | undefined;
  onSelect: (id: string | null) => void;
  omitNoise: () => boolean;
  onOmitNoiseChange: (value: boolean) => void;
  observationsQuery: ReturnType<typeof useTraceObservationsQuery>;
  compact?: boolean;
}> = (props) => (
    <div class={props.compact ? "px-4 pb-4" : undefined}>
    <MonitorTraceTurnTree
      observations={props.flatObservations}
      selectedId={props.selectedId() ?? null}
      onSelect={(id) => props.onSelect(id)}
      omitNoise={props.omitNoise()}
      onOmitNoiseChange={props.onOmitNoiseChange}
      showOmitNoiseToggle={!props.compact}
      traceRoot={{
        name: props.traceName ?? "trace root",
        latencyMs:
          props.traceLatency !== null && props.traceLatency !== undefined && props.traceLatency >= 0
            ? props.traceLatency * 1000
            : undefined,
      }}
      selectedTraceRoot={props.selectedId() === null}
      onTraceRootSelect={() => props.onSelect(null)}
    />
    <Show when={props.observationsQuery.hasNextPage}>
      <Button
        variant="ghost"
        size="sm"
        class="mt-32 w-full"
        disabled={props.observationsQuery.isFetchingNextPage}
        onClick={() => void props.observationsQuery.fetchNextPage()}
      >
        {props.observationsQuery.isFetchingNextPage ? "Loading…" : "Load more observations"}
      </Button>
    </Show>
  </div>
);

export const TraceObservationDetailPane: Component<{
  selectedId: () => string | null | undefined;
  selectedQuery: ReturnType<typeof useObservationDetailQuery>;
  selected: () => Observation | null | undefined;
  selectedScores: () => ReturnType<typeof toScoreSummary>[];
  traceIoQuery: ReturnType<typeof useTraceIoQuery>;
  traceView: () => TraceWithDetails | null;
}> = (props) => {
  const detail = (): JSX.Element | null => {
    const selectedId = props.selectedId();
    if (selectedId === undefined) return null;
    if (props.selectedQuery.isPending) {
      return <Skeleton class="h-256 w-full" />;
    }
    if (props.selectedQuery.isError) {
      return (
        <InlineNotice tone="danger" role="alert">
          {props.selectedQuery.error instanceof Error
            ? props.selectedQuery.error.message
            : "Failed to load observation"}
        </InlineNotice>
      );
    }
    const observation = props.selected();
    if (observation) {
      return <ObservationDetailPanel observation={observation} scores={props.selectedScores()} />;
    }
    if (props.traceIoQuery.isPending) {
      return <Skeleton class="h-256 w-full" />;
    }
    if (props.traceIoQuery.isError) {
      return (
        <InlineNotice tone="danger" role="alert">
          {props.traceIoQuery.error instanceof Error
            ? props.traceIoQuery.error.message
            : "Failed to load trace IO"}
        </InlineNotice>
      );
    }
    const trace = props.traceView();
    if (!trace) return null;
    return (
      <TraceDetailPanel
        input={trace.input}
        output={trace.output}
        metadata={trace.metadata}
        scores={trace.scores.map(toScoreSummary)}
      />
    );
  };

  return (
    <Show
      when={props.selectedId() !== undefined}
      fallback={
        <div class="flex h-full items-center justify-center text-sm text-fg-tertiary">
          Select the trace root or an observation to load its details.
        </div>
      }
    >
      {detail()}
    </Show>
  );
};

export const TraceObservationWorkspace: Component<TraceObservationWorkspaceProps> = (props) => {
  const state = useTraceObservationState(props.traceId);
  const trace = () => state.trace();

  return (
    <MonitorTraceTurnTreeShell
      class={props.class}
      tree={
        <Show
          when={!state.traceQuery.isPending}
          fallback={<LoadingState label="Loading observations…" class="justify-center p-64" />}
        >
          <Show
            when={!state.traceQuery.isError}
            fallback={
              <InlineNotice tone="danger" role="alert" class="m-48">
                {state.traceQuery.error instanceof Error
                  ? state.traceQuery.error.message
                  : "Failed to load trace"}
              </InlineNotice>
            }
          >
            <TraceObservationTreePane
              traceName={trace()?.name}
              traceLatency={trace()?.latency}
              flatObservations={state.flatObservations()}
              selectedId={state.selectedId}
              onSelect={state.setSelectedId}
              omitNoise={state.omitNoise}
              onOmitNoiseChange={state.setOmitNoise}
              observationsQuery={state.observationsQuery}
            />
          </Show>
        </Show>
      }
      showDetailPlaceholder={state.selectedId() === undefined}
      detail={
        <TraceObservationDetailPane
          selectedId={state.selectedId}
          selectedQuery={state.selectedQuery}
          selected={state.selected}
          selectedScores={state.selectedScores}
          traceIoQuery={state.traceIoQuery}
          traceView={state.traceView}
        />
      }
    />
  );
};

export function traceObservationSummary(trace: TraceWithDetails, observationCount: number) {
  return {
    latency: formatLatency(trace.latency),
    observations:
      trace.observationCount >= 0
        ? `${observationCount} / ${trace.observationCount}`
        : String(observationCount),
  };
}
