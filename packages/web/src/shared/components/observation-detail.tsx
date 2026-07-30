/**
 * Observation detail panel — shared by the trace-detail page and the
 * session-detail page. Renders the full shape of a single observation
 * (type/level badges, timing/cost/model/token stats, IO tabs, and any scores
 * attributed to it).
 */
import { Clock, Coins, Cpu, Layers, Star } from "lucide-react";
import { IoViewer } from "@/shared/components/io-viewer";
import { JsonViewer } from "@/shared/components/json-viewer";
import { LevelBadge, ObservationTypeBadge } from "@/shared/components/observation-badges";
import { Badge } from "@/shared/components/ui/badge";
import { Separator } from "@/shared/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { formatCost, formatDateTime, formatDuration, formatTokens } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";

/**
 * Minimal score shape rendered by ScoreList. Both the trace page's `Score`
 * and the session page's `SessionScore` structurally satisfy it.
 */
export type ScoreSummary = {
  id: string;
  name: string;
  value: number | null;
  stringValue: string | null;
  source: string;
};

export function StatChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface-inset/60 px-3 py-2">
      <Icon className="h-4 w-4 text-fg-tertiary" />
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-[0.06em] text-fg-tertiary">{label}</div>
        <div className="tnum text-sm font-semibold text-fg-primary">{value}</div>
      </div>
    </div>
  );
}

export function ScoreList({ scores }: { scores: ScoreSummary[] }) {
  if (scores.length === 0) {
    return <p className="text-sm text-fg-tertiary">No scores.</p>;
  }
  return (
    <div className="space-y-2">
      {scores.map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <Star className="h-3.5 w-3.5 text-fg-tertiary" />
            <span className="font-medium text-fg-primary">{s.name}</span>
            <Badge variant="muted">{s.source}</Badge>
          </div>
          <span className="tnum font-mono text-fg-secondary">
            {s.stringValue ?? s.value?.toFixed(4) ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function IoTabs({
  input,
  output,
  metadata,
}: {
  input: unknown;
  output: unknown;
  metadata: unknown;
}) {
  return (
    <Tabs defaultValue="input">
      <TabsList>
        <TabsTrigger value="input">Input</TabsTrigger>
        <TabsTrigger value="output">Output</TabsTrigger>
        <TabsTrigger value="metadata">Metadata</TabsTrigger>
      </TabsList>
      <TabsContent value="input" className="mt-3">
        <IoViewer data={input} />
      </TabsContent>
      <TabsContent value="output" className="mt-3">
        <IoViewer data={output} />
      </TabsContent>
      <TabsContent value="metadata" className="mt-3">
        <JsonViewer data={metadata} />
      </TabsContent>
    </Tabs>
  );
}

export function ObservationDetail({
  observation: o,
  scores,
}: {
  observation: Observation;
  scores: ScoreSummary[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ObservationTypeBadge type={o.type} />
        <span className="text-base font-semibold text-fg-primary">{o.name ?? "(unnamed)"}</span>
        <LevelBadge level={o.level} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatChip icon={Clock} label="Duration" value={formatDuration(o.startTime, o.endTime)} />
        <StatChip icon={Coins} label="Cost" value={formatCost(o.calculatedTotalCost ?? null)} />
        <StatChip icon={Cpu} label="Model" value={o.model ?? "—"} />
        <StatChip
          icon={Layers}
          label="Tokens"
          value={
            o.totalTokens > 0
              ? `${formatTokens(o.promptTokens)} → ${formatTokens(o.completionTokens)} (${formatTokens(o.totalTokens)})`
              : "—"
          }
        />
      </div>

      <div className="space-y-1 text-xs text-fg-tertiary">
        <p>Start: {formatDateTime(o.startTime)}</p>
        <p>End: {formatDateTime(o.endTime)}</p>
        <p className="font-mono">ID: {o.id}</p>
        {o.statusMessage && <p>Status: {o.statusMessage}</p>}
      </div>

      <Separator />

      <IoTabs input={o.input} output={o.output} metadata={o.metadata} />

      {scores.length > 0 && (
        <>
          <Separator />
          <div>
            <h3 className="mb-2 text-sm font-semibold text-fg-primary">Scores</h3>
            <ScoreList scores={scores} />
          </div>
        </>
      )}
    </div>
  );
}
