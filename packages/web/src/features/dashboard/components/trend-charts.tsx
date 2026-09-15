/**
 * Time-series trend charts: activity, latency, and errors per day.
 */

import {
  ACTIVITY_CHART_HEIGHT,
  Chart,
  DUAL_AXIS_CHART_MARGIN,
  formatChartCompact,
} from "@peri/ui";
import type { Component } from "solid-js";
import { formatMs } from "@/shared/lib/format";
import type { DashboardDaily } from "@/shared/lib/types";
import { dayTick } from "../chart-utils";
import { ChartCard } from "./chart-card";

export const ActivityChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const labels = () => props.data.map((d) => d.date);
  return (
    <ChartCard
      title="Activity"
      description="Traces and observations per day, with token usage overlay."
      isEmpty={props.data.length === 0}
      emptyMessage="No telemetry in the selected range."
    >
      <Chart.Cartesian
        labels={labels()}
        height={ACTIVITY_CHART_HEIGHT}
        margin={DUAL_AXIS_CHART_MARGIN}
        formatX={dayTick}
      >
        <Chart.Bars
          axis="left"
          series={[
            {
              key: "traces",
              name: "traces",
              color: "var(--chart-1)",
              values: props.data.map((d) => d.traces),
            },
            {
              key: "observations",
              name: "observations",
              color: "var(--chart-2)",
              values: props.data.map((d) => d.observations),
              opacity: 0.6,
            },
          ]}
        />
        <Chart.Line
          axis="right"
          formatY={formatChartCompact}
          series={[
            {
              name: "tokens",
              color: "var(--chart-3)",
              values: props.data.map((d) => d.tokens),
            },
          ]}
        />
      </Chart.Cartesian>
    </ChartCard>
  );
};

export const LatencyTrendChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const rows = () => props.data.filter((d) => d.observations > 0);
  const labels = () => rows().map((d) => d.date);
  return (
    <ChartCard
      title="Generation latency"
      description="Average and p95 generation latency per day."
      isEmpty={rows().length === 0}
    >
      <Chart.Cartesian labels={labels()} formatX={dayTick}>
        <Chart.Line
          formatY={(value) => formatMs(value)}
          series={[
            {
              name: "avg",
              color: "var(--chart-2)",
              values: rows().map((d) => d.avgLatencyMs),
            },
            {
              name: "p95",
              color: "var(--chart-3)",
              values: rows().map((d) => d.p95LatencyMs),
            },
          ]}
        />
      </Chart.Cartesian>
    </ChartCard>
  );
};

export const ErrorsChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const labels = () => props.data.map((d) => d.date);
  const values = () => props.data.map((d) => d.errors);
  const hasErrors = () => values().some((v) => v > 0);
  return (
    <ChartCard
      title="Errors"
      description="Error-level observations per day."
      isEmpty={!hasErrors()}
      emptyMessage="No errors in the selected range."
    >
      <Chart.Cartesian labels={labels()} formatX={dayTick}>
        <Chart.Bars
          series={[
            {
              key: "errors",
              color: "var(--danger)",
              values: values(),
            },
          ]}
        />
      </Chart.Cartesian>
    </ChartCard>
  );
};
