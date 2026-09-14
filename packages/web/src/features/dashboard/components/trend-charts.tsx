/**
 * Time-series trend charts: activity, latency, and errors per day.
 */

import type { Component } from "solid-js";
import { formatMs, formatNumber } from "@/shared/lib/format";
import type { DashboardDaily } from "@/shared/lib/types";
import { ChartCard } from "./chart-card";
import { ActivityComposedChart, MultiLineChart, SingleBarChart } from "./svg-charts";

export const ActivityChart: Component<{ data: DashboardDaily[] }> = (props) => {
  const labels = () => props.data.map((d) => d.date);
  return (
    <ChartCard
      title="Activity"
      description="Traces and observations per day, with token usage overlay."
      isEmpty={props.data.length === 0}
      emptyMessage="No telemetry in the selected range."
    >
      <ActivityComposedChart
        labels={labels()}
        traces={props.data.map((d) => d.traces)}
        observations={props.data.map((d) => d.observations)}
        tokens={props.data.map((d) => d.tokens)}
      />
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
      <MultiLineChart
        labels={labels()}
        formatY={(v) => formatMs(v)}
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
      <SingleBarChart labels={labels()} values={values()} color="var(--danger)" />
    </ChartCard>
  );
};
