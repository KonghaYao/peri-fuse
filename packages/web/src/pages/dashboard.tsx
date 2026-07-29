import { useQuery } from "@tanstack/react-query";
import { Activity, DollarSign, ListTree, Star } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ErrorState, PageHeader } from "@/components/state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getDashboard } from "@/lib/api";
import { formatCost, formatNumber } from "@/lib/format";

function SummaryCard({
  title,
  value,
  icon: Icon,
}: {
  title: string;
  value: string;
  icon: typeof ListTree;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboard,
  });

  const dashboard = query.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Dashboard"
        description="Overview of the telemetry stored in this lite project."
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
              />
              <SummaryCard
                title="Total observations"
                value={formatNumber(dashboard.summary.totalObservations)}
                icon={Activity}
              />
              <SummaryCard
                title="Total scores"
                value={formatNumber(dashboard.summary.totalScores)}
                icon={Star}
              />
              <SummaryCard
                title="Total cost"
                value={formatCost(dashboard.summary.totalCost)}
                icon={DollarSign}
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
                        />
                        <Legend />
                        <Bar
                          yAxisId="counts"
                          dataKey="traces"
                          name="traces"
                          fill="hsl(var(--primary))"
                          fillOpacity={0.8}
                        />
                        <Bar
                          yAxisId="counts"
                          dataKey="observations"
                          name="observations"
                          fill="hsl(var(--primary))"
                          fillOpacity={0.35}
                        />
                        <Line
                          yAxisId="cost"
                          type="monotone"
                          dataKey="cost"
                          name="cost"
                          stroke="hsl(var(--chart-2, 160 84% 39%))"
                          strokeWidth={2}
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
