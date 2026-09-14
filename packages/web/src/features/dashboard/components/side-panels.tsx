/**
 * Secondary dashboard panels: cache, scores, top users, recent errors.
 */

import { A } from "@solidjs/router";
import { AlertTriangle, ArrowUpRight } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import { formatDateTime, formatNumber, formatPercent, formatTokens } from "@/shared/lib/format";
import type { DashboardDaily, DashboardRecentError, DashboardUserBucket } from "@/shared/lib/types";
import { ChartCard } from "./chart-card";
import { HorizontalBarChart, MultiLineChart } from "./svg-charts";

export const CacheTrendChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const rows = () => props.data.filter((d) => d.observations > 0);
  const labels = () => rows().map((d) => d.date);
  return (
    <ChartCard
      title="Cache hit rate"
      description="Cached read tokens / gross input tokens per day."
      isEmpty={rows().length === 0}
    >
      <MultiLineChart
        labels={labels()}
        yDomain={[0, 1]}
        formatY={(v) => formatPercent(v)}
        series={[
          {
            name: "hit rate",
            color: "var(--chart-4)",
            values: rows().map((d) => d.cacheHitRate),
          },
        ]}
      />
    </ChartCard>
  );
};

export const ScoreTrendChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const rows = () => props.data.filter((d) => d.avgScore !== null);
  const labels = () => rows().map((d) => d.date);
  return (
    <ChartCard
      title="Score trend"
      description="Average score value per day."
      isEmpty={rows().length === 0}
      emptyMessage="No scores in the selected range."
    >
      <MultiLineChart
        labels={labels()}
        yDomain={[0, 1]}
        formatY={(v) => v.toFixed(3)}
        series={[
          {
            name: "avg score",
            color: "var(--chart-5)",
            values: rows().map((d) => d.avgScore ?? 0),
          },
        ]}
      />
    </ChartCard>
  );
};

export const TopUsersChart: Component<{ data: DashboardUserBucket[] }> = (props) => (
  <ChartCard
    title="Top users"
    description="Token consumption by user."
    isEmpty={props.data.length === 0}
    emptyMessage="No user-attributed usage."
  >
    <HorizontalBarChart
      labels={props.data.map((d) => d.userId)}
      formatX={(v) => formatTokens(v)}
      series={[
        {
          name: "tokens",
          color: "var(--chart-1)",
          values: props.data.map((d) => d.tokens),
        },
      ]}
    />
  </ChartCard>
);

export const RecentErrorsPanel: Component<{ data: DashboardRecentError[] }> = (props) => (
  <ChartCard
    title="Recent errors"
    description="Latest error-level observations."
    isEmpty={props.data.length === 0}
    emptyMessage="No errors in the selected range."
  >
    <ul class="divide-y divide-border">
      <For each={props.data}>
        {(error) => (
          <li class="flex items-start gap-2.5 py-2.5">
            <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-danger" size={16} />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-sm font-medium text-fg-primary">
                  {error.name ?? "(unnamed)"}
                  <Show when={error.type}>
                    <span class="ml-1.5 text-xs font-normal text-fg-tertiary">{error.type}</span>
                  </Show>
                </span>
                <span class="shrink-0 text-xs text-fg-tertiary">
                  {error.startTime ? formatDateTime(error.startTime) : "—"}
                </span>
              </div>
              <Show when={error.statusMessage}>
                <p class="mt-0.5 truncate text-xs text-fg-tertiary">{error.statusMessage}</p>
              </Show>
              <Show when={error.traceId}>
                {(traceId) => (
                  <A
                    href={`/traces/${encodeURIComponent(traceId())}`}
                    class="mt-0.5 inline-flex items-center gap-0.5 text-xs text-brand hover:underline"
                  >
                    View trace <ArrowUpRight class="h-3 w-3" size={12} />
                  </A>
                )}
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
    <A
      href="/errors"
      class="mt-3 inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline"
    >
      Investigate all errors <ArrowUpRight class="h-3 w-3" size={12} />
    </A>
  </ChartCard>
);
