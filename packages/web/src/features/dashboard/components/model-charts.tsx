/**
 * Model breakdown charts and observation severity donut.
 */

import type { Component } from "solid-js";
import { formatMs, formatTokens } from "@/shared/lib/format";
import type { DashboardLevelBucket, DashboardModelBucket } from "@/shared/lib/types";
import { ChartCard } from "./chart-card";
import { DonutChart, HorizontalBarChart } from "./svg-charts";

const LEVEL_COLORS: Record<string, string> = {
  ERROR: "var(--danger)",
  WARNING: "var(--warning)",
  DEBUG: "var(--info)",
  DEFAULT: "var(--fg-tertiary)",
};

export const TokensByModelChart: Component<{ data: DashboardModelBucket[] }> = (props) => (
  <ChartCard
    title="Tokens by model"
    description="Generation tokens grouped by model."
    isEmpty={props.data.length === 0}
    emptyMessage="No generation tokens recorded."
  >
    <HorizontalBarChart
      labels={props.data.map((d) => d.model)}
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

export const LatencyByModelChart: Component<{ data: DashboardModelBucket[] }> = (props) => {
  const rows = () => props.data.filter((d) => d.observations > 0);
  return (
    <ChartCard
      title="Latency by model"
      description="p50 vs p95 generation latency per model."
      isEmpty={rows().length === 0}
      emptyMessage="No generation latency recorded."
    >
      <HorizontalBarChart
        labels={rows().map((d) => d.model)}
        formatX={(v) => formatMs(v)}
        series={[
          {
            name: "p50",
            color: "var(--chart-2)",
            values: rows().map((d) => d.p50LatencyMs),
          },
          {
            name: "p95",
            color: "var(--chart-3)",
            values: rows().map((d) => d.p95LatencyMs),
          },
        ]}
      />
    </ChartCard>
  );
};

export const LevelsDonut: Component<{ data: DashboardLevelBucket[] }> = (props) => (
  <ChartCard
    title="Observation levels"
    description="Distribution of observation severity levels."
    isEmpty={props.data.length === 0}
    emptyMessage="No observations recorded."
  >
    <DonutChart
      segments={props.data.map((level) => ({
        label: level.level,
        value: level.count,
        color: LEVEL_COLORS[level.level] ?? "var(--chart-4)",
        opacity: level.level === "DEFAULT" ? 0.4 : 0.9,
      }))}
    />
  </ChartCard>
);
