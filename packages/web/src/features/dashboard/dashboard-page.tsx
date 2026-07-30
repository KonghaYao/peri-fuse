import { Activity, Coins, DollarSign, ListTree } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { ErrorState, PageHeader } from "@/shared/components/state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useDashboardQuery } from "@/shared/hooks/queries";
import { formatCost, formatNumber, formatTokens } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";

/** Spectra semantic colors for observation levels (donut chart). */
const LEVEL_COLORS: Record<string, string> = {
  ERROR: "var(--danger)",
  WARNING: "var(--warning)",
  DEBUG: "var(--info)",
  DEFAULT: "var(--fg-tertiary)",
};

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--line-strong)",
  borderRadius: 8,
  fontSize: 12,
} as const;

/** Spectra §6.7 — label → mono value, 3px category color bar. */
function SummaryCard({
  title,
  value,
  icon: Icon,
  accent,
}: {
  title: string;
  value: string;
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
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const query = useDashboardQuery();

  const dashboard = query.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Dashboard"
        description="Overview of the telemetry stored in this lite project."
        actions={<AutoRefreshControl />}
      />

      <div className="flex-1 overflow-y-auto p-6">
        {query.isLoading ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
            <Skeleton className="h-80" />
          </div>
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : dashboard ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                title="Total traces"
                value={formatNumber(dashboard.summary.totalTraces)}
                icon={ListTree}
                accent="bg-chart-1"
              />
              <SummaryCard
                title="Total observations"
                value={formatNumber(dashboard.summary.totalObservations)}
                icon={Activity}
                accent="bg-chart-2"
              />
              <SummaryCard
                title="Total tokens"
                value={formatTokens(dashboard.summary.totalTokens)}
                icon={Coins}
                accent="bg-chart-5"
              />
              <SummaryCard
                title="Total cost"
                value={formatCost(dashboard.summary.totalCost)}
                icon={DollarSign}
                accent="bg-chart-3"
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Daily activity</CardTitle>
                <CardDescription>
                  Traces and observations per day over the last 30 days, with daily cost overlay.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {dashboard.daily.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    No telemetry in the last 30 days.
                  </p>
                ) : (
                  <div className="h-80 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={dashboard.daily}>
                        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11 }}
                          tickFormatter={(d: string) => d.slice(5)}
                        />
                        <YAxis yAxisId="counts" tick={{ fontSize: 11 }} allowDecimals={false} />
                        <YAxis
                          yAxisId="cost"
                          orientation="right"
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v: number) => `$${v.toPrecision(2)}`}
                        />
                        <Tooltip
                          labelFormatter={(d) => String(d)}
                          formatter={(value, name) =>
                            name === "cost"
                              ? [formatCost(Number(value)), "cost"]
                              : [formatNumber(Number(value)), name]
                          }
                          contentStyle={TOOLTIP_STYLE}
                          labelStyle={{ color: "var(--fg-primary)" }}
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
                          yAxisId="cost"
                          type="monotone"
                          dataKey="cost"
                          name="cost"
                          stroke="var(--chart-3)"
                          strokeWidth={2}
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Cost by model</CardTitle>
                  <CardDescription>Generation cost grouped by model.</CardDescription>
                </CardHeader>
                <CardContent>
                  {dashboard.byModel.length === 0 ? (
                    <p className="py-16 text-center text-sm text-muted-foreground">
                      No generation cost recorded.
                    </p>
                  ) : (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={dashboard.byModel}
                          layout="vertical"
                          margin={{ left: 8, right: 16 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            strokeOpacity={0.2}
                            horizontal={false}
                          />
                          <XAxis
                            type="number"
                            tick={{ fontSize: 11 }}
                            tickFormatter={(v: number) => `$${v.toPrecision(2)}`}
                          />
                          <YAxis
                            type="category"
                            dataKey="model"
                            width={130}
                            tick={{ fontSize: 11 }}
                          />
                          <Tooltip
                            formatter={(value, name) => [formatCost(Number(value)), String(name)]}
                            contentStyle={TOOLTIP_STYLE}
                            labelStyle={{ color: "var(--fg-primary)" }}
                          />
                          <Bar
                            dataKey="cost"
                            name="cost"
                            fill="var(--chart-1)"
                            radius={[0, 3, 3, 0]}
                            barSize={14}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Observation levels</CardTitle>
                  <CardDescription>Distribution of observation severity levels.</CardDescription>
                </CardHeader>
                <CardContent>
                  {dashboard.levels.length === 0 ? (
                    <p className="py-16 text-center text-sm text-muted-foreground">
                      No observations recorded.
                    </p>
                  ) : (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={dashboard.levels}
                            dataKey="count"
                            nameKey="level"
                            innerRadius="60%"
                            outerRadius="85%"
                            paddingAngle={2}
                            stroke="none"
                          >
                            {dashboard.levels.map((l) => (
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
                            labelStyle={{ color: "var(--fg-primary)" }}
                          />
                          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
