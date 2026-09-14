import {
  Badge,
  type EnhancedDataTableColumn,
  formatCountLabelAsLevel,
  IoPreviewCell,
  LevelCountsDisplay,
  LocalIsoDate,
  monitorLevelSymbol,
  Skeleton,
  TokenUsageBadge,
  TruncatedIdCell,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { type JSX, Show } from "solid-js";
import type { TracesTableRow } from "@/features/traces/join-core-metrics";
import { formatIntervalSeconds, formatPercent, numberFormatter } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";

const LEVEL_BG: Record<string, string> = {
  ERROR: "bg-danger-subtle",
  WARNING: "bg-warning-subtle",
  DEBUG: "bg-surface-inset",
  DEFAULT: "bg-surface-inset",
};

const LEVEL_TEXT: Record<string, string> = {
  ERROR: "text-danger",
  WARNING: "text-warning",
  DEBUG: "text-fg-secondary",
  DEFAULT: "text-fg-secondary",
};

function metricsPending(row: TracesTableRow) {
  return row.levelCounts === null;
}

function MetricsSkeleton(props: { class?: string }) {
  return <Skeleton class={cn("h-4", props.class ?? "w-12")} />;
}

function levelCountsCell(row: TracesTableRow): JSX.Element {
  if (!row.levelCounts) return <MetricsSkeleton class="w-1/2" />;
  const counts = Object.entries(row.levelCounts)
    .filter(([, count]) => count > 0)
    .map(([level, count]) => ({
      level: formatCountLabelAsLevel(level),
      count,
      symbol: monitorLevelSymbol(formatCountLabelAsLevel(level)),
    }));
  return <LevelCountsDisplay counts={counts} />;
}

export const tracesTableColumns: EnhancedDataTableColumn<TracesTableRow>[] = [
  {
    id: "timestamp",
    header: "Timestamp",
    accessor: (row) => row.timestamp,
    sortable: true,
    hideable: false,
    cell: (row) => (row.timestamp ? <LocalIsoDate date={new Date(row.timestamp)} /> : null),
  },
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name,
    sortable: true,
    cell: (row) => row.name ?? undefined,
  },
  {
    id: "input",
    header: "Input",
    hideable: true,
    cell: (row) =>
      metricsPending(row) && row.input === null ? (
        <MetricsSkeleton class="w-3/4" />
      ) : (
        <IoPreviewCell data={row.input} variant="input" />
      ),
  },
  {
    id: "output",
    header: "Output",
    hideable: true,
    cell: (row) =>
      metricsPending(row) && row.output === null ? (
        <MetricsSkeleton class="w-3/4" />
      ) : (
        <IoPreviewCell data={row.output} variant="output" />
      ),
  },
  {
    id: "levelCounts",
    header: "Observation Levels",
    cell: levelCountsCell,
  },
  {
    id: "latency",
    header: "Latency",
    cell: (row) => {
      if (metricsPending(row) && row.latency === null) return <MetricsSkeleton />;
      return (
        <Show when={row.latency !== null && row.latency !== undefined}>
          <span class="tnum text-nowrap font-mono text-[12.5px]">
            {formatIntervalSeconds(row.latency!)}
          </span>
        </Show>
      );
    },
  },
  {
    id: "tokens",
    header: "Tokens",
    accessor: (row) => row.totalTokens,
    cell: (row) => {
      if (row.promptTokens === null || row.completionTokens === null) {
        return <MetricsSkeleton class="w-16" />;
      }
      return (
        <TokenUsageBadge
          inputUsage={row.promptTokens}
          outputUsage={row.completionTokens}
          totalUsage={row.totalTokens ?? 0}
          inline
        />
      );
    },
  },
  {
    id: "environment",
    header: "Environment",
    cell: (row) => (
      <Show when={row.environment}>
        {(value) => (
          <Badge
            tone="neutral"
            class="max-w-fit truncate rounded-sm px-1 font-normal"
            title={value()}
          >
            {value()}
          </Badge>
        )}
      </Show>
    ),
  },
  {
    id: "tags",
    header: "Tags",
    hideable: true,
    cell: (row) => (
      <Show when={row.tags.length > 0}>
        <div class="flex flex-wrap gap-x-2 gap-y-1">
          {row.tags.slice(0, 4).map((tag) => (
            <Badge tone="neutral" class="font-normal">
              {tag}
            </Badge>
          ))}
          <Show when={row.tags.length > 4}>
            <Badge tone="neutral">+{row.tags.length - 4}</Badge>
          </Show>
        </div>
      </Show>
    ),
  },
  {
    id: "metadata",
    header: "Metadata",
    hideable: true,
    cell: (row) =>
      metricsPending(row) && row.metadata === null ? (
        <MetricsSkeleton class="w-3/4" />
      ) : (
        <IoPreviewCell data={row.metadata} />
      ),
  },
  {
    id: "sessionId",
    header: "Session",
    hideable: true,
    cell: (row) => (
      <Show when={row.sessionId}>
        {(value) => (
          <A
            href={`/sessions/${encodeURIComponent(value())}`}
            class="text-brand hover:underline"
            onClick={(event: MouseEvent) => event.stopPropagation()}
          >
            <TruncatedIdCell value={value()} />
          </A>
        )}
      </Show>
    ),
  },
  {
    id: "userId",
    header: "User",
    hideable: true,
    cell: (row) => <Show when={row.userId}>{(value) => <TruncatedIdCell value={value()} />}</Show>,
  },
  {
    id: "observationCount",
    header: "Observations",
    hideable: true,
    cell: (row) => {
      if (row.observationCount === null) return <MetricsSkeleton class="w-8" />;
      return <span>{numberFormatter(row.observationCount, 0)}</span>;
    },
  },
  {
    id: "level",
    header: "Level",
    hideable: true,
    cell: (row) => {
      if (row.level === null) return <MetricsSkeleton class="w-10" />;
      return (
        <Show when={row.level} fallback={<span>-</span>}>
          {(value) => (
            <span
              class={cn(
                "rounded-sm p-0.5 text-xs",
                LEVEL_BG[value()] ?? LEVEL_BG.DEFAULT,
                LEVEL_TEXT[value()] ?? LEVEL_TEXT.DEFAULT,
              )}
            >
              {value()}
            </span>
          )}
        </Show>
      );
    },
  },
  {
    id: "version",
    header: "Version",
    hideable: true,
    accessor: (row) => row.version,
  },
  {
    id: "release",
    header: "Release",
    hideable: true,
    accessor: (row) => row.release,
  },
  {
    id: "traceId",
    header: "Trace ID",
    hideable: true,
    cell: (row) => <TruncatedIdCell value={row.id} />,
  },
  {
    id: "inputTokens",
    header: "Input Tokens",
    hideable: true,
    cell: (row) => {
      if (row.promptTokens === null) return <MetricsSkeleton class="w-10" />;
      return <span>{numberFormatter(row.promptTokens, 0)}</span>;
    },
  },
  {
    id: "outputTokens",
    header: "Output Tokens",
    hideable: true,
    cell: (row) => {
      if (row.completionTokens === null) return <MetricsSkeleton class="w-10" />;
      return <span>{numberFormatter(row.completionTokens, 0)}</span>;
    },
  },
  {
    id: "totalTokens",
    header: "Total Tokens",
    hideable: true,
    cell: (row) => {
      if (row.totalTokens === null) return <MetricsSkeleton class="w-10" />;
      return <span>{numberFormatter(row.totalTokens, 0)}</span>;
    },
  },
  {
    id: "cachedTokens",
    header: "Cached Tokens",
    hideable: true,
    cell: (row) => {
      if (row.cachedTokens === null) return <MetricsSkeleton class="w-10" />;
      return <span>{numberFormatter(row.cachedTokens, 0)}</span>;
    },
  },
  {
    id: "cacheHitRate",
    header: "Cache Hit Rate",
    hideable: true,
    cell: (row) => {
      if (row.cacheHitRate === null) return <MetricsSkeleton class="w-10" />;
      return <span>{formatPercent(row.cacheHitRate)}</span>;
    },
  },
];
