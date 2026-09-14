import { MonitorTimelineDialogShell, MonitorTimelineShell } from "@peri/ui";
import { type Component, createMemo, createSignal, Show } from "solid-js";
import {
  buildTimelineSegments,
  mergeTimelineSegments,
  toScoreSummary,
} from "@/shared/components/observations/observation-adapters";
import { ObservationDetailPanel } from "@/shared/components/observations/observation-detail-panel";
import type { Observation, SessionScore, SessionTrace, TraceWithDetails } from "@/shared/lib/types";

export type TimelineSource = {
  name: string;
  observations: Observation[];
  scores: SessionScore[];
};

function resolveSources(props: {
  trace?: TraceWithDetails;
  traces?: SessionTrace[];
}): TimelineSource[] {
  if (props.traces) {
    return props.traces.map((trace) => ({
      name: trace.name ?? trace.id,
      observations: trace.observations,
      scores: trace.scores,
    }));
  }
  if (props.trace) {
    return [
      {
        name: props.trace.name ?? "(unnamed trace)",
        observations: props.trace.observations,
        scores: props.trace.scores,
      },
    ];
  }
  return [];
}

export const ObservationTimelineDialog: Component<{
  trace?: TraceWithDetails;
  traces?: SessionTrace[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  omitNoise?: boolean;
}> = (props) => {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const sources = createMemo(() => resolveSources(props));
  const segments = createMemo(() => {
    const list = sources();
    if (list.length === 1) {
      return buildTimelineSegments(list[0]!.observations, { omitNoise: props.omitNoise ?? true });
    }
    return mergeTimelineSegments(
      list.map((source, traceIndex) => ({ traceIndex, observations: source.observations })),
      props.omitNoise ?? true,
    );
  });
  const traceNames = createMemo(() => sources().map((source) => source.name));
  const selected = createMemo(() => {
    const id = selectedId();
    if (!id) return null;
    for (const source of sources()) {
      const observation = source.observations.find((item) => item.id === id);
      if (observation) {
        return {
          observation,
          scores: source.scores
            .filter((score) => score.observationId === observation.id)
            .map(toScoreSummary),
        };
      }
    }
    return null;
  });

  const title = () => (sources().length === 1 ? "Timeline" : "Session timeline");
  const description = () =>
    sources().length === 1
      ? (sources()[0]?.name ?? "Trace observations")
      : `${sources().length} traces on this page`;

  return (
    <MonitorTimelineDialogShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={title()}
      description={description()}
      timeline={
        <MonitorTimelineShell
          segments={segments()}
          traceNames={traceNames()}
          selectedId={selectedId()}
          onSelect={setSelectedId}
        />
      }
      detail={
        <Show when={selected()}>
          {(entry) => (
            <ObservationDetailPanel observation={entry().observation} scores={entry().scores} />
          )}
        </Show>
      }
    />
  );
};
