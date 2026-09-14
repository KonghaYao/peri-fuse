import {
  MonitorObservationLevelBadge,
  MonitorObservationTypeBadge,
  ScoreListShell,
  Separator,
} from "@peri/ui";
import { Clock, Cpu, Layers, ListTree, Star } from "lucide-solid";
import { type Component, Show } from "solid-js";
import type { ScoreSummary } from "@/shared/components/observations/observation-adapters";
import { ObservationIoTabs } from "@/shared/components/observations/observation-io-tabs";
import { StatChip } from "@/shared/components/observations/stat-chip";
import { formatClockTime, formatDateTime, formatDuration, formatTokens } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";

export const ObservationDetailPanel: Component<{
  observation: Observation;
  scores: ScoreSummary[];
}> = (props) => {
  const o = () => props.observation;
  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <MonitorObservationTypeBadge type={o().type} />
        <span class="text-base font-semibold text-fg-primary">{o().name ?? "(unnamed)"}</span>
        <MonitorObservationLevelBadge level={o().level} />
      </div>

      <div class="grid grid-cols-2 gap-2">
        <StatChip
          icon={Clock}
          label={o().type === "EVENT" ? "At" : "Duration"}
          value={
            o().type === "EVENT"
              ? formatClockTime(o().startTime)
              : formatDuration(o().startTime, o().endTime)
          }
        />
        <StatChip icon={Cpu} label="Model" value={o().model ?? "—"} />
        <StatChip
          icon={Layers}
          label="Tokens"
          value={
            o().totalTokens > 0
              ? `${formatTokens(o().promptTokens)} → ${formatTokens(o().completionTokens)} (${formatTokens(o().totalTokens)})`
              : "—"
          }
        />
      </div>

      <div class="space-y-1 text-xs text-fg-tertiary">
        <p>Start: {formatDateTime(o().startTime)}</p>
        <p>End: {formatDateTime(o().endTime)}</p>
        <p class="font-mono">ID: {o().id}</p>
        <Show when={o().statusMessage}>{(message) => <p>Status: {message()}</p>}</Show>
      </div>

      <Separator />

      <ObservationIoTabs
        observation={o()}
        input={o().input}
        output={o().output}
        metadata={o().metadata}
      />

      <Show when={props.scores.length > 0}>
        <Separator />
        <div>
          <h3 class="mb-2 text-sm font-semibold text-fg-primary">Scores</h3>
          <ScoreListShell scores={props.scores} />
        </div>
      </Show>
    </div>
  );
};

export const TraceDetailPanel: Component<{
  input: unknown;
  output: unknown;
  metadata: unknown;
  scores: ScoreSummary[];
}> = (props) => (
  <div class="space-y-4">
    <div class="flex items-center gap-2 text-base font-semibold text-fg-primary">
      <ListTree class="h-4 w-4 text-brand" size={16} />
      Trace
    </div>
    <ObservationIoTabs input={props.input} output={props.output} metadata={props.metadata} />
    <Separator />
    <div>
      <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
        <Star class="h-3.5 w-3.5 text-fg-tertiary" size={14} />
        Scores ({props.scores.length})
      </h3>
      <ScoreListShell scores={props.scores} />
    </div>
  </div>
);
