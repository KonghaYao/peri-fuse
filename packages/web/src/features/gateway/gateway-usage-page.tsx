/**
 * Gateway Usage statistics page.
 */
import { Card, CardContent, CardHeader, CardTitle, Input, PageHeaderShell } from "@peri/ui";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
import {
  type GatewayQueryHandle,
  GatewayQuerySection,
} from "@/features/gateway/components/gateway-query-section";
import { LoadingRows } from "@/features/gateway/components/loading-rows";
import {
  useGwUsageByModelQuery,
  useGwUsageByProviderQuery,
  useGwUsageDailyQuery,
  useGwUsageSummaryQuery,
} from "@/shared/hooks/gateway-queries";
import type {
  DailySpendRow,
  UsageByModelRow,
  UsageByProviderRow,
  UsageSummary,
} from "@/shared/lib/gateway-api";

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const SummaryCards: Component<{ summary: UsageSummary }> = (props) => {
  const successRate = () =>
    props.summary.totalRequests > 0
      ? `${((props.summary.successfulRequests / props.summary.totalRequests) * 100).toFixed(1)}%`
      : "—";

  const cards = () => [
    { label: "Total Spend", value: `$${props.summary.totalSpend.toFixed(4)}` },
    {
      label: "Total Tokens",
      value: (
        props.summary.totalPromptTokens + props.summary.totalCompletionTokens
      ).toLocaleString(),
    },
    { label: "Requests", value: props.summary.totalRequests.toLocaleString() },
    { label: "Success Rate", value: successRate() },
  ];

  return (
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards().map((card) => (
        <Card>
          <CardContent class="p-4">
            <p class="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
              {card.label}
            </p>
            <p class="mt-1 text-lg font-semibold text-fg-primary">{card.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

/** Inputs for the pure Gateway Usage view, kept separate from query ownership for stable testing. */
export interface GatewayUsageContentProps {
  range: { start: string; end: string };
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  summaryQuery: GatewayQueryHandle<UsageSummary>;
  dailyQuery: GatewayQueryHandle<DailySpendRow[]>;
  byModelQuery: GatewayQueryHandle<UsageByModelRow[]>;
  byProviderQuery: GatewayQueryHandle<UsageByProviderRow[]>;
}

/** Renders all four Gateway Usage query boundaries without owning network or date state. */
export const GatewayUsageContent: Component<GatewayUsageContentProps> = (props) => (
  <div class="space-y-6 p-6">
    <div class="flex items-center gap-3">
      <label for="gateway-usage-from" class="text-[13px] font-medium text-fg-secondary">
        From
      </label>
      <Input
        id="gateway-usage-from"
        type="date"
        class="w-40"
        value={props.range.start}
        onInput={(e) => props.onStartDateChange(e.currentTarget.value)}
      />
      <label for="gateway-usage-to" class="text-[13px] font-medium text-fg-secondary">
        To
      </label>
      <Input
        id="gateway-usage-to"
        type="date"
        class="w-40"
        value={props.range.end}
        onInput={(e) => props.onEndDateChange(e.currentTarget.value)}
      />
    </div>

    <GatewayQuerySection
      label="usage summary"
      query={props.summaryQuery}
      isEmpty={() => false}
      loading={<LoadingRows rows={2} />}
      empty={null}
    >
      {(summary) => <SummaryCards summary={summary} />}
    </GatewayQuerySection>

    <Card>
      <CardHeader class="pb-3">
        <CardTitle class="text-base">By Model</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <GatewayQuerySection
          label="usage by model"
          query={props.byModelQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<LoadingRows rows={4} />}
          empty={<p class="px-4 pb-4 text-sm text-fg-tertiary">No usage data in this range.</p>}
        >
          {(rows) => (
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th class="px-4 py-2.5">Model</th>
                  <th class="px-4 py-2.5 text-right">Requests</th>
                  <th class="px-4 py-2.5 text-right">Prompt Tokens</th>
                  <th class="px-4 py-2.5 text-right">Completion Tokens</th>
                  <th class="px-4 py-2.5 text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr class="border-b border-border/50">
                    <td class="px-4 py-2.5 font-mono text-[13px] text-fg-primary">
                      {row.model || "(unknown)"}
                    </td>
                    <td class="px-4 py-2.5 text-right text-fg-secondary">
                      {row.totalRequests.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalPromptTokens.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalCompletionTokens.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
                      ${row.totalSpend.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </GatewayQuerySection>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="pb-3">
        <CardTitle class="text-base">By Provider</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <GatewayQuerySection
          label="usage by provider"
          query={props.byProviderQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<LoadingRows rows={4} />}
          empty={<p class="px-4 pb-4 text-sm text-fg-tertiary">No usage data in this range.</p>}
        >
          {(rows) => (
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th class="px-4 py-2.5">Provider</th>
                  <th class="px-4 py-2.5 text-right">Requests</th>
                  <th class="px-4 py-2.5 text-right">Prompt Tokens</th>
                  <th class="px-4 py-2.5 text-right">Completion Tokens</th>
                  <th class="px-4 py-2.5 text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr class="border-b border-border/50">
                    <td class="px-4 py-2.5 text-fg-primary">{row.provider || "(unknown)"}</td>
                    <td class="px-4 py-2.5 text-right text-fg-secondary">
                      {row.totalRequests.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalPromptTokens.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                      {row.totalCompletionTokens.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
                      ${row.totalSpend.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </GatewayQuerySection>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="pb-3">
        <CardTitle class="text-base">Daily Breakdown</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <GatewayQuerySection
          label="daily usage"
          query={props.dailyQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<LoadingRows rows={4} />}
          empty={<p class="px-4 pb-4 text-sm text-fg-tertiary">No usage data in this range.</p>}
        >
          {(rows) => (
            <div class="max-h-[400px] overflow-y-auto">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-surface-raised">
                  <tr class="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                    <th class="px-4 py-2.5">Date</th>
                    <th class="px-4 py-2.5">Model</th>
                    <th class="hidden px-4 py-2.5 md:table-cell">Provider</th>
                    <th class="px-4 py-2.5 text-right">Requests</th>
                    <th class="px-4 py-2.5 text-right">Tokens</th>
                    <th class="px-4 py-2.5 text-right">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr class="border-b border-border/50">
                      <td class="px-4 py-2.5 text-xs text-fg-secondary">{row.date}</td>
                      <td class="px-4 py-2.5 font-mono text-xs text-fg-primary">
                        {row.model || "—"}
                      </td>
                      <td class="hidden px-4 py-2.5 text-xs text-fg-tertiary md:table-cell">
                        {row.provider || "—"}
                      </td>
                      <td class="px-4 py-2.5 text-right text-xs text-fg-secondary">
                        {row.apiRequests.toLocaleString()}
                      </td>
                      <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
                        {(row.promptTokens + row.completionTokens).toLocaleString()}
                      </td>
                      <td class="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
                        ${row.spend.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GatewayQuerySection>
      </CardContent>
    </Card>
  </div>
);

const UsageQueries: Component<{
  range: { start: string; end: string };
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
}> = (props) => {
  const params = { startDate: props.range.start, endDate: props.range.end };
  const summaryQuery = useGwUsageSummaryQuery(params);
  const dailyQuery = useGwUsageDailyQuery(params);
  const byModelQuery = useGwUsageByModelQuery(params);
  const byProviderQuery = useGwUsageByProviderQuery(params);

  return (
    <GatewayUsageContent
      range={props.range}
      onStartDateChange={props.onStartDateChange}
      onEndDateChange={props.onEndDateChange}
      summaryQuery={summaryQuery}
      dailyQuery={dailyQuery}
      byModelQuery={byModelQuery}
      byProviderQuery={byProviderQuery}
    />
  );
};

const UsageContent: Component = () => {
  const [range, setRange] = createSignal(defaultRange());

  return (
    <Show when={range()} keyed>
      {(currentRange) => (
        <UsageQueries
          range={currentRange}
          onStartDateChange={(start) => setRange((current) => ({ ...current, start }))}
          onEndDateChange={(end) => setRange((current) => ({ ...current, end }))}
        />
      )}
    </Show>
  );
};

export const GatewayUsagePage: Component = () => (
  <GatewayProjectGate title="Usage" description="Spend and token usage analytics.">
    <div class="flex h-full flex-col">
      <PageHeaderShell title="Usage" description="Spend and token usage analytics." />
      <div class="flex-1 overflow-y-auto">
        <UsageContent />
      </div>
    </div>
  </GatewayProjectGate>
);
