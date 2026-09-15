/**
 * Gateway Usage statistics page.
 */
import {
  BlockLoadingRows,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  PageHeaderShell,
  type QueryHandle,
  QuerySection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableView,
} from "@peri/ui";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
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
    <div class="grid grid-cols-2 gap-16 lg:grid-cols-4">
      {cards().map((card) => (
        <Card>
          <CardContent class="p-16">
            <p class="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
              {card.label}
            </p>
            <p class="mt-4 text-lg font-semibold text-fg-primary">{card.value}</p>
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
  summaryQuery: QueryHandle<UsageSummary>;
  dailyQuery: QueryHandle<DailySpendRow[]>;
  byModelQuery: QueryHandle<UsageByModelRow[]>;
  byProviderQuery: QueryHandle<UsageByProviderRow[]>;
}

/** Renders all four Gateway Usage query boundaries without owning network or date state. */
export const GatewayUsageContent: Component<GatewayUsageContentProps> = (props) => (
  <div class="space-y-24 p-24">
    <div class="flex items-center gap-12">
      <label for="gateway-usage-from" class="text-[13px] font-medium text-fg-secondary">
        From
      </label>
      <Input
        id="gateway-usage-from"
        type="date"
        class="w-160"
        value={props.range.start}
        onInput={(e) => props.onStartDateChange(e.currentTarget.value)}
      />
      <label for="gateway-usage-to" class="text-[13px] font-medium text-fg-secondary">
        To
      </label>
      <Input
        id="gateway-usage-to"
        type="date"
        class="w-160"
        value={props.range.end}
        onInput={(e) => props.onEndDateChange(e.currentTarget.value)}
      />
    </div>

    <QuerySection
      label="usage summary"
      query={props.summaryQuery}
      isEmpty={() => false}
      loading={<BlockLoadingRows rows={2} />}
      empty={null}
    >
      {(summary) => <SummaryCards summary={summary} />}
    </QuerySection>

    <Card>
      <CardHeader class="pb-12">
        <CardTitle class="text-base">By Model</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <QuerySection
          label="usage by model"
          query={props.byModelQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<BlockLoadingRows rows={4} />}
          empty={<p class="px-16 pb-16 text-sm text-fg-tertiary">No usage data in this range.</p>}
        >
          {(rows) => (
            <TableView>
              <TableView.Body>
                <Table wrapperClass="min-h-0 flex-1">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead class="text-right">Requests</TableHead>
                      <TableHead class="text-right">Prompt Tokens</TableHead>
                      <TableHead class="text-right">Completion Tokens</TableHead>
                      <TableHead class="text-right">Spend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow>
                        <TableCell class="font-mono text-[13px] text-fg-primary">
                          {row.model || "(unknown)"}
                        </TableCell>
                        <TableCell class="text-right text-fg-secondary">
                          {row.totalRequests.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-tertiary">
                          {row.totalPromptTokens.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-tertiary">
                          {row.totalCompletionTokens.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-secondary">
                          ${row.totalSpend.toFixed(4)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableView.Body>
            </TableView>
          )}
        </QuerySection>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="pb-12">
        <CardTitle class="text-base">By Provider</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <QuerySection
          label="usage by provider"
          query={props.byProviderQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<BlockLoadingRows rows={4} />}
          empty={<p class="px-16 pb-16 text-sm text-fg-tertiary">No usage data in this range.</p>}
        >
          {(rows) => (
            <TableView>
              <TableView.Body>
                <Table wrapperClass="min-h-0 flex-1">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead class="text-right">Requests</TableHead>
                      <TableHead class="text-right">Prompt Tokens</TableHead>
                      <TableHead class="text-right">Completion Tokens</TableHead>
                      <TableHead class="text-right">Spend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow>
                        <TableCell class="text-fg-primary">{row.provider || "(unknown)"}</TableCell>
                        <TableCell class="text-right text-fg-secondary">
                          {row.totalRequests.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-tertiary">
                          {row.totalPromptTokens.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-tertiary">
                          {row.totalCompletionTokens.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-secondary">
                          ${row.totalSpend.toFixed(4)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableView.Body>
            </TableView>
          )}
        </QuerySection>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="pb-12">
        <CardTitle class="text-base">Daily Breakdown</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <QuerySection
          label="daily usage"
          query={props.dailyQuery}
          isEmpty={(rows) => rows.length === 0}
          loading={<BlockLoadingRows rows={4} />}
          empty={<p class="px-16 pb-16 text-sm text-fg-tertiary">No usage data in this range.</p>}
        >
          {(rows) => (
            <TableView class="max-h-400">
              <TableView.Body>
                <Table wrapperClass="min-h-0 flex-1">
                  <TableHeader class="sticky top-0 z-10 bg-surface-raised">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead class="hidden md:table-cell">Provider</TableHead>
                      <TableHead class="text-right">Requests</TableHead>
                      <TableHead class="text-right">Tokens</TableHead>
                      <TableHead class="text-right">Spend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow>
                        <TableCell class="text-xs text-fg-secondary">{row.date}</TableCell>
                        <TableCell class="font-mono text-xs text-fg-primary">
                          {row.model || "—"}
                        </TableCell>
                        <TableCell class="hidden text-xs text-fg-tertiary md:table-cell">
                          {row.provider || "—"}
                        </TableCell>
                        <TableCell class="text-right text-xs text-fg-secondary">
                          {row.apiRequests.toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-tertiary">
                          {(row.promptTokens + row.completionTokens).toLocaleString()}
                        </TableCell>
                        <TableCell class="text-right font-mono text-xs text-fg-secondary">
                          ${row.spend.toFixed(4)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableView.Body>
            </TableView>
          )}
        </QuerySection>
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
