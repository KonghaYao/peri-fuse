/**
 * Secondary dashboard panels: cache hit-rate trend, score trend, top users by
 * token consumption, and the recent-errors list.
 */

import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDateTime, formatNumber, formatPercent, formatTokens } from "@/shared/lib/format";
import type { DashboardDaily, DashboardRecentError, DashboardUserBucket } from "@/shared/lib/types";
import { ChartCard, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from "./chart-card";

const dayTick = (d: string) => d.slice(5);

export function CacheTrendChart({ data }: { data: DashboardDaily[] }) {
  const rows = data.filter((d) => d.observations > 0);
  return (
    <ChartCard
      title="Cache hit rate"
      description="Cached read tokens / gross input tokens per day."
      isEmpty={rows.length === 0}
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={dayTick} />
            <YAxis
              tick={{ fontSize: 11 }}
              domain={[0, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              width={44}
            />
            <Tooltip
              labelFormatter={(d) => String(d)}
              formatter={(value) => [formatPercent(Number(value)), "hit rate"]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Line
              type="monotone"
              dataKey="cacheHitRate"
              name="hit rate"
              stroke="var(--chart-4)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function ScoreTrendChart({ data }: { data: DashboardDaily[] }) {
  const rows = data.filter((d) => d.avgScore !== null);
  return (
    <ChartCard
      title="Score trend"
      description="Average score value per day."
      isEmpty={rows.length === 0}
      emptyMessage="No scores in the selected range."
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={dayTick} />
            <YAxis tick={{ fontSize: 11 }} domain={[0, 1]} width={40} />
            <Tooltip
              labelFormatter={(d) => String(d)}
              formatter={(value) => [Number(value).toFixed(3), "avg score"]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
            />
            <Line
              type="monotone"
              dataKey="avgScore"
              name="avg score"
              stroke="var(--chart-5)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function TopUsersChart({ data }: { data: DashboardUserBucket[] }) {
  return (
    <ChartCard
      title="Top users"
      description="Token consumption by user."
      isEmpty={data.length === 0}
      emptyMessage="No user-attributed usage."
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <YAxis type="category" dataKey="userId" width={130} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value, name) =>
                name === "tokens"
                  ? [formatTokens(Number(value)), "tokens"]
                  : [formatNumber(Number(value)), String(name)]
              }
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

export function RecentErrorsPanel({ data }: { data: DashboardRecentError[] }) {
  return (
    <ChartCard
      title="Recent errors"
      description="Latest error-level observations."
      isEmpty={data.length === 0}
      emptyMessage="No errors in the selected range."
    >
      <ul className="divide-y divide-border">
        {data.map((e) => (
          <li key={e.id} className="flex items-start gap-2.5 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-fg-primary">
                  {e.name ?? "(unnamed)"}
                  {e.type ? (
                    <span className="ml-1.5 text-xs font-normal text-fg-tertiary">{e.type}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-fg-tertiary">
                  {e.startTime ? formatDateTime(e.startTime) : "—"}
                </span>
              </div>
              {e.statusMessage ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{e.statusMessage}</p>
              ) : null}
              {e.traceId ? (
                <Link
                  to={`/traces/${encodeURIComponent(e.traceId)}`}
                  className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
                >
                  View trace <ArrowUpRight className="h-3 w-3" />
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <Link
        to="/errors"
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline"
      >
        Investigate all errors <ArrowUpRight className="h-3 w-3" />
      </Link>
    </ChartCard>
  );
}
