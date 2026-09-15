/**
 * Secondary dashboard panels: cache, scores, top users, recent errors.
 */

import { Chart } from "@peri/ui";
import { A } from "@solidjs/router";
import { AlertTriangle, ArrowUpRight } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import { formatDateTime, formatNumber, formatPercent, formatTokens } from "@/shared/lib/format";
import type { DashboardDaily, DashboardRecentError, DashboardUserBucket } from "@/shared/lib/types";
import { dayTick } from "../chart-utils";
import { PanelCard } from "@peri/ui";

export const CacheTrendChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const rows = () => props.data.filter((d) => d.observations > 0);
  const labels = () => rows().map((d) => d.date);
  return (
    <PanelCard
      title="Cache hit rate"
      description="Cached read tokens / gross input tokens per day."
      isEmpty={rows().length === 0}
    >
      <Chart.Cartesian labels={labels()} formatX={dayTick}>
        <Chart.Line
          domain={[0, 1]}
          formatY={(v) => formatPercent(v)}
          series={[
            {
              name: "hit rate",
              color: "var(--chart-4)",
              values: rows().map((d) => d.cacheHitRate),
            },
          ]}
        />
      </Chart.Cartesian>
    </PanelCard>
  );
};

export const ScoreTrendChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const rows = () => props.data.filter((d) => d.avgScore !== null);
  const labels = () => rows().map((d) => d.date);
  return (
    <PanelCard
      title="Score trend"
      description="Average score value per day."
      isEmpty={rows().length === 0}
      emptyMessage="No scores in the selected range."
    >
      <Chart.Cartesian labels={labels()} formatX={dayTick}>
        <Chart.Line
          domain={[0, 1]}
          formatY={(v) => v.toFixed(3)}
          series={[
            {
              name: "avg score",
              color: "var(--chart-5)",
              values: rows().map((d) => d.avgScore ?? 0),
            },
          ]}
        />
      </Chart.Cartesian>
    </PanelCard>
  );
};

export const TopUsersChart: Component<{ data: DashboardUserBucket[] }> = (props) => (
  <PanelCard
    title="Top users"
    description="Token consumption by user."
    isEmpty={props.data.length === 0}
    emptyMessage="No user-attributed usage."
  >
    <Chart.BarsHorizontal
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
  </PanelCard>
);

export const RecentErrorsPanel: Component<{ data: DashboardRecentError[] }> = (props) => (
  <PanelCard
    title="Recent errors"
    description="Latest error-level observations."
    isEmpty={props.data.length === 0}
    emptyMessage="No errors in the selected range."
  >
    <ul class="divide-y divide-border">
      <For each={props.data}>
        {(error) => (
          <li class="flex items-start gap-10 py-10">
            <AlertTriangle class="mt-2 h-16 w-16 shrink-0 text-danger" size={16} />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-8">
                <span class="truncate text-sm font-medium text-fg-primary">
                  {error.name ?? "(unnamed)"}
                  <Show when={error.type}>
                    <span class="ml-6 text-xs font-normal text-fg-tertiary">{error.type}</span>
                  </Show>
                </span>
                <span class="shrink-0 text-xs text-fg-tertiary">
                  {error.startTime ? formatDateTime(error.startTime) : "—"}
                </span>
              </div>
              <Show when={error.statusMessage}>
                <p class="mt-2 truncate text-xs text-fg-tertiary">{error.statusMessage}</p>
              </Show>
              <Show when={error.traceId}>
                {(traceId) => (
                  <A
                    href={`/traces/${encodeURIComponent(traceId())}`}
                    class="mt-2 inline-flex items-center gap-2 text-xs text-brand hover:underline"
                  >
                    View trace <ArrowUpRight class="h-12 w-12" size={12} />
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
      class="mt-12 inline-flex items-center gap-4 text-xs font-medium text-danger hover:underline"
    >
      Investigate all errors <ArrowUpRight class="h-12 w-12" size={12} />
    </A>
  </PanelCard>
);
