/**
 * Model breakdown charts: token consumption and latency percentiles grouped by
 * model, plus the observation severity-level donut.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMs, formatNumber, formatTokens } from "@/shared/lib/format";
import type { DashboardLevelBucket, DashboardModelBucket } from "@/shared/lib/types";
import { ChartCard, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from "./chart-card";

/** Spectra semantic colors for observation levels (donut chart). */
const LEVEL_COLORS: Record<string, string> = {
  ERROR: "var(--danger)",
  WARNING: "var(--warning)",
  DEBUG: "var(--info)",
  DEFAULT: "var(--fg-tertiary)",
};

export function TokensByModelChart({ data }: { data: DashboardModelBucket[] }) {
  return (
    <ChartCard
      title="Tokens by model"
      description="Generation tokens grouped by model."
      isEmpty={data.length === 0}
      emptyMessage="No generation tokens recorded."
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <YAxis type="category" dataKey="model" width={130} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value, name) => [formatTokens(Number(value)), String(name)]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Bar
              dataKey="tokens"
              name="tokens"
              fill="var(--chart-1)"
              radius={[0, 3, 3, 0]}
              barSize={14}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function LatencyByModelChart({ data }: { data: DashboardModelBucket[] }) {
  const rows = data.filter((d) => d.observations > 0);
  return (
    <ChartCard
      title="Latency by model"
      description="p50 vs p95 generation latency per model."
      isEmpty={rows.length === 0}
      emptyMessage="No generation latency recorded."
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatMs(v)}
            />
            <YAxis type="category" dataKey="model" width={130} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value, name) => [formatMs(Number(value)), String(name)]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Legend />
            <Bar
              dataKey="p50LatencyMs"
              name="p50"
              fill="var(--chart-2)"
              radius={[0, 3, 3, 0]}
              barSize={10}
            />
            <Bar
              dataKey="p95LatencyMs"
              name="p95"
              fill="var(--chart-3)"
              radius={[0, 3, 3, 0]}
              barSize={10}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function LevelsDonut({ data }: { data: DashboardLevelBucket[] }) {
  return (
    <ChartCard
      title="Observation levels"
      description="Distribution of observation severity levels."
      isEmpty={data.length === 0}
      emptyMessage="No observations recorded."
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="level"
              innerRadius="60%"
              outerRadius="85%"
              paddingAngle={2}
              stroke="none"
            >
              {data.map((l) => (
                <Cell
                  key={l.level}
                  fill={LEVEL_COLORS[l.level] ?? "var(--chart-4)"}
                  fillOpacity={l.level === "DEFAULT" ? 0.4 : 0.9}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => [formatNumber(Number(value)), String(name)]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
