import {
  AutoRefreshIntervalControl,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeaderShell,
  Skeleton,
} from "@peri/ui";
import { useSearchParams } from "@solidjs/router";
import {
  Activity,
  AlertTriangle,
  Coins,
  Gauge,
  ListTree,
  Sparkles,
  Timer,
  Zap,
} from "lucide-solid";
import { type Component, createMemo, For, Show } from "solid-js";
import { useDashboardQuery } from "@/shared/hooks/queries";
import { formatMs, formatNumber, formatPercent, formatTokens } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import {
  REFRESH_OPTIONS,
  setRefreshInterval,
  useRefreshInterval,
} from "@/shared/store/auto-refresh";
import { LatencyByModelChart, LevelsDonut, TokensByModelChart } from "./components/model-charts";
import {
  CacheTrendChart,
  RecentErrorsPanel,
  ScoreTrendChart,
  TopUsersChart,
} from "./components/side-panels";
import { ActivityChart, ErrorsChart, LatencyTrendChart } from "./components/trend-charts";
import { queryParamsForRange, RANGE_PRESETS, type RangeKey, resolveRange } from "./range-presets";

/** Spectra §6.7 — label → mono value, 3px category color bar, optional subtext. */
const KpiCard: Component<{
  title: string;
  value: string;
  sub?: string;
  icon: typeof ListTree;
  accent: string;
}> = (props) => (
  <Card class="relative overflow-hidden py-4">
    <span class={cn("absolute inset-y-0 left-0 w-[3px]", props.accent)} />
    <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-1.5">
      <CardTitle class="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
        {props.title}
      </CardTitle>
      <props.icon class="h-4 w-4 text-fg-tertiary" size={16} />
    </CardHeader>
    <CardContent>
      <div class="tnum font-mono text-2xl font-semibold tracking-tight text-fg-primary">
        {props.value}
      </div>
      <Show when={props.sub}>
        <p class="mt-0.5 text-xs text-fg-tertiary">{props.sub}</p>
      </Show>
    </CardContent>
  </Card>
);

const DashboardLoading: Component = () => (
  <div class="space-y-4">
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <For each={Array.from({ length: 8 })}>{() => <Skeleton class="h-28" />}</For>
    </div>
    <Skeleton class="h-80" />
  </div>
);

const DashboardBody: Component<{ range: RangeKey }> = (props) => {
  const query = useDashboardQuery(queryParamsForRange(props.range));
  const dashboard = () => query.data;
  const retry = () => void query.refetch();

  return (
    <Show
      when={!query.isLoading}
      fallback={
        <div role="status" aria-live="polite" aria-label="Loading dashboard">
          <DashboardLoading />
        </div>
      }
    >
      <Show
        when={!query.error}
        fallback={
          <div class="rounded-md border border-danger/30 bg-danger-subtle px-4 py-3">
            <p class="text-sm font-medium text-danger">Could not load dashboard.</p>
            <p class="mt-1 text-sm text-fg-secondary">
              {query.error instanceof Error ? query.error.message : "Request failed"}
            </p>
            <Button
              variant="default"
              size="sm"
              class="mt-3"
              disabled={query.isFetching}
              onClick={retry}
            >
              {query.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        }
      >
        <Show when={dashboard()}>
          {(data) => (
            <div class="space-y-6" aria-busy={query.isFetching}>
              <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <KpiCard
                  title="Traces"
                  value={formatNumber(data().summary.totalTraces)}
                  icon={ListTree}
                  accent="bg-chart-1"
                />
                <KpiCard
                  title="Observations"
                  value={formatNumber(data().summary.totalObservations)}
                  icon={Activity}
                  accent="bg-chart-2"
                />
                <KpiCard
                  title="Tokens"
                  value={formatTokens(data().summary.totalTokens)}
                  sub={`${formatTokens(data().summary.inputTokens)} in · ${formatTokens(data().summary.outputTokens)} out`}
                  icon={Coins}
                  accent="bg-chart-5"
                />
                <KpiCard
                  title="Generations"
                  value={formatNumber(data().summary.totalGenerations)}
                  icon={Sparkles}
                  accent="bg-chart-3"
                />
                <KpiCard
                  title="Avg latency"
                  value={formatMs(data().summary.avgLatencyMs)}
                  icon={Timer}
                  accent="bg-chart-2"
                />
                <KpiCard
                  title="p95 latency"
                  value={formatMs(data().summary.p95LatencyMs)}
                  icon={Gauge}
                  accent="bg-chart-3"
                />
                <KpiCard
                  title="Error rate"
                  value={formatPercent(data().summary.errorRate)}
                  sub={`${formatNumber(data().summary.errorCount)} errors`}
                  icon={AlertTriangle}
                  accent="bg-danger"
                />
                <KpiCard
                  title="Cache hit rate"
                  value={formatPercent(data().summary.cacheHitRate)}
                  sub={`${formatTokens(data().summary.totalCachedTokens)} cached`}
                  icon={Zap}
                  accent="bg-chart-4"
                />
              </div>

              <ActivityChart data={data().daily} />

              <div class="grid gap-4 lg:grid-cols-3">
                <LatencyTrendChart data={data().daily} />
                <ErrorsChart data={data().daily} />
                <LevelsDonut data={data().levels} />
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <TokensByModelChart data={data().byModel} />
                <LatencyByModelChart data={data().byModel} />
              </div>

              <div class="grid gap-4 lg:grid-cols-3">
                <CacheTrendChart data={data().daily} />
                <ScoreTrendChart data={data().daily} />
                <TopUsersChart data={data().topUsers} />
              </div>

              <RecentErrorsPanel data={data().recentErrors} />
            </div>
          )}
        </Show>
      </Show>
    </Show>
  );
};

export const DashboardPage: Component = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const refreshInterval = useRefreshInterval();

  const range = createMemo(() => resolveRange(searchParams.range));

  const setRange = (next: RangeKey) => {
    setSearchParams({ range: next === "30d" ? undefined : next }, { replace: true });
  };

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Dashboard"
        description="Overview of the telemetry stored in this lite project."
        actions={
          <div class="flex items-center gap-2">
            <div class="flex items-center rounded-md border border-border p-0.5">
              <For each={RANGE_PRESETS}>
                {(preset) => (
                  <button
                    type="button"
                    onClick={() => setRange(preset.key)}
                    class={cn(
                      "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      range() === preset.key
                        ? "bg-accent text-fg-primary"
                        : "text-fg-tertiary hover:text-fg-secondary",
                    )}
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </div>
            <AutoRefreshIntervalControl
              value={refreshInterval()}
              options={[...REFRESH_OPTIONS]}
              onChange={setRefreshInterval}
            />
          </div>
        }
      />

      <div class="flex-1 overflow-y-auto p-6">
        <Show when={range()} keyed>
          {(activeRange) => <DashboardBody range={activeRange} />}
        </Show>
      </div>
    </div>
  );
};
