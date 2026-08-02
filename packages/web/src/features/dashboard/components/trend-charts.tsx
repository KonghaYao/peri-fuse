/**
 * Time-series trend charts for the dashboard: request/token activity, generation
 * latency percentiles, and error counts — all bucketed per day.
 */

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMs, formatNumber, formatTokens } from "@/shared/lib/format";
import type { DashboardDaily } from "@/shared/lib/types";
import { ChartCard, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from "./chart-card";

const dayTick = (d: string) => d.slice(5);

export function ActivityChart({ data }: { data: DashboardDaily[] }) {
  return (
    <ChartCard
      title="Activity"
      description="Traces and observations per day, with token usage overlay."
      isEmpty={data.length === 0}
      emptyMessage="No telemetry in the selected range."
    >
      <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={dayTick} />
            <YAxis yAxisId="counts" tick={{ fontSize: 11 }} allowDecimals={false} />
            <YAxis
              yAxisId="tokens"
              orientation="right"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <Tooltip
              labelFormatter={(d) => String(d)}
              formatter={(value, name) =>
                name === "tokens"
                  ? [formatTokens(Number(value)), "tokens"]
                  : [formatNumber(Number(value)), name]
              }
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Legend />
            <Bar
              yAxisId="counts"
              dataKey="traces"
              name="traces"
              fill="var(--chart-1)"
              fillOpacity={0.85}
              radius={[2, 2, 0, 0]}
            />
            <Bar
              yAxisId="counts"
              dataKey="observations"
              name="observations"
              fill="var(--chart-2)"
              fillOpacity={0.6}
              radius={[2, 2, 0, 0]}
            />
            <Line
              yAxisId="tokens"
              type="monotone"
              dataKey="tokens"
              name="tokens"
              stroke="var(--chart-3)"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function LatencyTrendChart({ data }: { data: DashboardDaily[] }) {
  const rows = data.filter((d) => d.observations > 0);
  return (
    <ChartCard
      title="Generation latency"
      description="Average and p95 generation latency per day."
      isEmpty={rows.length === 0}
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={dayTick} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMs(v)} width={64} />
            <Tooltip
              labelFormatter={(d) => String(d)}
              formatter={(value, name) => [formatMs(Number(value)), name]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="avgLatencyMs"
              name="avg"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="p95LatencyMs"
              name="p95"
              stroke="var(--chart-3)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function ErrorsChart({ data }: { data: DashboardDaily[] }) {
  const rows = data.filter((d) => d.errors > 0);
  return (
    <ChartCard
      title="Errors"
      description="Error-level observations per day."
      isEmpty={rows.length === 0}
      emptyMessage="No errors in the selected range."
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={dayTick} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              labelFormatter={(d) => String(d)}
              formatter={(value, name) => [formatNumber(Number(value)), name]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Bar dataKey="errors" name="errors" fill="var(--danger)" radius={[2, 2, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
