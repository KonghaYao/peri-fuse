import {
  Activity,
  AlertTriangle,
  Coins,
  Gauge,
  ListTree,
  Sparkles,
  Timer,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { ErrorState, PageHeader } from "@/shared/components/state";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useDashboardQuery } from "@/shared/hooks/queries";
import { formatMs, formatNumber, formatPercent, formatTokens } from "@/shared/lib/format";
import type { DashboardQueryParams } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { LatencyByModelChart, LevelsDonut, TokensByModelChart } from "./components/model-charts";
import {
  CacheTrendChart,
  RecentErrorsPanel,
  ScoreTrendChart,
  TopUsersChart,
} from "./components/side-panels";
import { ActivityChart, ErrorsChart, LatencyTrendChart } from "./components/trend-charts";

/** Quick time-range presets for the dashboard. `hours === null` means all time. */
const RANGE_PRESETS = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 24 * 7 },
  { key: "30d", label: "30d", hours: 24 * 30 },
  { key: "all", label: "All", hours: null },
] as const;

type RangeKey = (typeof RANGE_PRESETS)[number]["key"];

/** Spectra §6.7 — label → mono value, 3px category color bar, optional subtext. */
function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: typeof ListTree;
  accent: string;
}) {
  return (
    <Card className="relative overflow-hidden py-4">
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", accent)} />
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1.5">
        <CardTitle className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-fg-tertiary" />
      </CardHeader>
      <CardContent>
        <div className="tnum font-mono text-2xl font-semibold tracking-tight text-fg-primary">
          {value}
        </div>
        {sub ? <p className="mt-0.5 text-xs text-fg-tertiary">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clock] = useState(() => Date.now());
  const rangeParam = searchParams.get("range");
  const range: RangeKey = RANGE_PRESETS.some((preset) => preset.key === rangeParam)
    ? (rangeParam as RangeKey)
    : "30d";

  const setRange = (next: RangeKey) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === "30d") params.delete("range");
        else params.set("range", next);
        return params;
      },
      { replace: true },
    );
  };

  const params = useMemo<DashboardQueryParams>(() => {
    const preset = RANGE_PRESETS.find((p) => p.key === range);
    if (!preset?.hours) return {};
    return { from: new Date(clock - preset.hours * 3600_000).toISOString() };
  }, [clock, range]);

  const query = useDashboardQuery(params);
  const dashboard = query.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Dashboard"
        description="Overview of the telemetry stored in this lite project."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-md border border-border p-0.5">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setRange(p.key)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                    range === p.key
                      ? "bg-accent text-fg-primary"
                      : "text-fg-tertiary hover:text-fg-secondary",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <AutoRefreshControl />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-6">
        {query.isLoading ? (
          <div className="space-y-4">
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
            <Skeleton className="h-80" />
          </div>
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : dashboard ? (
          <div className="space-y-6">
            {/* KPI cards */}
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="Traces"
                value={formatNumber(dashboard.summary.totalTraces)}
                icon={ListTree}
                accent="bg-chart-1"
              />
              <KpiCard
                title="Observations"
                value={formatNumber(dashboard.summary.totalObservations)}
                icon={Activity}
                accent="bg-chart-2"
              />
              <KpiCard
                title="Tokens"
                value={formatTokens(dashboard.summary.totalTokens)}
                sub={`${formatTokens(dashboard.summary.inputTokens)} in · ${formatTokens(dashboard.summary.outputTokens)} out`}
                icon={Coins}
                accent="bg-chart-5"
              />
              <KpiCard
                title="Generations"
                value={formatNumber(dashboard.summary.totalGenerations)}
                icon={Sparkles}
                accent="bg-chart-3"
              />
              <KpiCard
                title="Avg latency"
                value={formatMs(dashboard.summary.avgLatencyMs)}
                icon={Timer}
                accent="bg-chart-2"
              />
              <KpiCard
                title="p95 latency"
                value={formatMs(dashboard.summary.p95LatencyMs)}
                icon={Gauge}
                accent="bg-chart-3"
              />
              <KpiCard
                title="Error rate"
                value={formatPercent(dashboard.summary.errorRate)}
                sub={`${formatNumber(dashboard.summary.errorCount)} errors`}
                icon={AlertTriangle}
                accent="bg-[var(--danger)]"
              />
              <KpiCard
                title="Cache hit rate"
                value={formatPercent(dashboard.summary.cacheHitRate)}
                sub={`${formatTokens(dashboard.summary.totalCachedTokens)} cached`}
                icon={Zap}
                accent="bg-chart-4"
              />
            </div>

            {/* Activity over time */}
            <ActivityChart data={dashboard.daily} />

            {/* Latency & errors trends */}
            <div className="grid gap-4 lg:grid-cols-3">
              <LatencyTrendChart data={dashboard.daily} />
              <ErrorsChart data={dashboard.daily} />
              <LevelsDonut data={dashboard.levels} />
            </div>

            {/* Model breakdown */}
            <div className="grid gap-4 md:grid-cols-2">
              <TokensByModelChart data={dashboard.byModel} />
              <LatencyByModelChart data={dashboard.byModel} />
            </div>

            {/* Cache / score / users */}
            <div className="grid gap-4 lg:grid-cols-3">
              <CacheTrendChart data={dashboard.daily} />
              <ScoreTrendChart data={dashboard.daily} />
              <TopUsersChart data={dashboard.topUsers} />
            </div>

            {/* Recent errors */}
            <RecentErrorsPanel data={dashboard.recentErrors} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
