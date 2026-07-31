/**
 * Gateway Usage statistics page.
 */
import { useState } from "react";
import { GatewayGuard } from "@/features/gateway/components/gateway-guard";
import { ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import {
  useGwUsageByModelQuery,
  useGwUsageByProviderQuery,
  useGwUsageDailyQuery,
  useGwUsageSummaryQuery,
} from "@/shared/hooks/gateway-queries";

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function UsageContent() {
  const [range, setRange] = useState(defaultRange);
  const params = { startDate: range.start, endDate: range.end };

  const summaryQuery = useGwUsageSummaryQuery(params);
  const dailyQuery = useGwUsageDailyQuery(params);
  const byModelQuery = useGwUsageByModelQuery(params);
  const byProviderQuery = useGwUsageByProviderQuery(params);

  if (summaryQuery.isLoading) return <LoadingRows rows={6} />;
  if (summaryQuery.error) return <ErrorState error={summaryQuery.error} />;

  const summary = summaryQuery.data;
  const successRate =
    summary && summary.totalRequests > 0
      ? ((summary.successfulRequests / summary.totalRequests) * 100).toFixed(1)
      : "—";

  return (
    <div className="space-y-6 p-6">
      {/* Date range picker */}
      <div className="flex items-center gap-3">
        <label className="text-[13px] font-medium text-fg-secondary">From</label>
        <Input
          type="date"
          className="w-40"
          value={range.start}
          onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
        />
        <label className="text-[13px] font-medium text-fg-secondary">To</label>
        <Input
          type="date"
          className="w-40"
          value={range.end}
          onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Total Spend", value: summary ? `$${summary.totalSpend.toFixed(4)}` : "—" },
          {
            label: "Total Tokens",
            value: summary
              ? (summary.totalPromptTokens + summary.totalCompletionTokens).toLocaleString()
              : "—",
          },
          { label: "Requests", value: summary ? summary.totalRequests.toLocaleString() : "—" },
          { label: "Success Rate", value: summary ? `${successRate}%` : "—" },
        ].map((card) => (
          <Card key={card.label}>
            <CardContent className="p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                {card.label}
              </p>
              <p className="mt-1 text-lg font-semibold text-fg-primary">{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* By model */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">By Model</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(byModelQuery.data ?? []).length === 0 ? (
            <p className="px-4 pb-4 text-sm text-fg-tertiary">No usage data in this range.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th className="px-4 py-2.5">Model</th>
                  <th className="px-4 py-2.5 text-right">Requests</th>
                  <th className="px-4 py-2.5 text-right">Prompt Tokens</th>
                  <th className="px-4 py-2.5 text-right">Completion Tokens</th>
                  <th className="px-4 py-2.5 text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {(byModelQuery.data ?? []).map((row) => (
                  <tr key={row.model} className="border-b border-border/50">
                    <td className="px-4 py-2.5 font-mono text-[13px] text-fg-primary">
                      {row.model || "(unknown)"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-fg-secondary">
                      {row.totalRequests.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalPromptTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalCompletionTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
                      ${row.totalSpend.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* By provider */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">By Provider</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(byProviderQuery.data ?? []).length === 0 ? (
            <p className="px-4 pb-4 text-sm text-fg-tertiary">No usage data in this range.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th className="px-4 py-2.5">Provider</th>
                  <th className="px-4 py-2.5 text-right">Requests</th>
                  <th className="px-4 py-2.5 text-right">Prompt Tokens</th>
                  <th className="px-4 py-2.5 text-right">Completion Tokens</th>
                  <th className="px-4 py-2.5 text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {(byProviderQuery.data ?? []).map((row) => (
                  <tr key={row.provider} className="border-b border-border/50">
                    <td className="px-4 py-2.5 text-fg-primary">{row.provider || "(unknown)"}</td>
                    <td className="px-4 py-2.5 text-right text-fg-secondary">
                      {row.totalRequests.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalPromptTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalCompletionTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
                      ${row.totalSpend.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Daily breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Daily Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(dailyQuery.data ?? []).length === 0 ? (
            <p className="px-4 pb-4 text-sm text-fg-tertiary">No usage data in this range.</p>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-raised">
                  <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Model</th>
                    <th className="hidden px-4 py-2.5 md:table-cell">Provider</th>
                    <th className="px-4 py-2.5 text-right">Requests</th>
                    <th className="px-4 py-2.5 text-right">Tokens</th>
                    <th className="px-4 py-2.5 text-right">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {(dailyQuery.data ?? []).map((row) => (
                    <tr key={row.id} className="border-b border-border/50">
                      <td className="px-4 py-2.5 text-xs text-fg-secondary">{row.date}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-fg-primary">
                        {row.model || "—"}
                      </td>
                      <td className="hidden px-4 py-2.5 text-xs text-fg-tertiary md:table-cell">
                        {row.provider || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-fg-secondary">
                        {row.apiRequests.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                        {(row.promptTokens + row.completionTokens).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
                        ${row.spend.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function GatewayUsagePage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Usage" description="Spend and token usage analytics." />
      <div className="flex-1 overflow-y-auto">
        <GatewayGuard>
          <UsageContent />
        </GatewayGuard>
      </div>
    </div>
  );
}
