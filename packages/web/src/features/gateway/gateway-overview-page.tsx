/**
 * Gateway Overview — stat cards + provider status list.
 */
import { Card, CardContent, CardHeader, CardTitle, PageHeaderShell } from "@peri/ui";
import { A } from "@solidjs/router";
import { Boxes, DollarSign, Server, Zap } from "lucide-solid";
import type { Component } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
import {
  type GatewayQueryHandle,
  GatewayQuerySection,
} from "@/features/gateway/components/gateway-query-section";
import { LoadingRows } from "@/features/gateway/components/loading-rows";
import { StatusBadge } from "@/features/gateway/components/status-badge";
import { useGwProvidersQuery, useGwUsageSummaryQuery } from "@/shared/hooks/gateway-queries";
import type { GatewayProvider, UsageSummary } from "@/shared/lib/gateway-api";

function last7Days() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

const StatCard: Component<{
  label: string;
  value: string;
  icon: typeof DollarSign;
}> = (props) => (
  <Card>
    <CardContent class="flex items-center gap-12 p-16">
      <div class="flex h-36 w-36 shrink-0 items-center justify-center rounded-md bg-brand-subtle">
        <props.icon class="h-16 w-16 text-brand" size={16} />
      </div>
      <div class="min-w-0">
        <p class="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
          {props.label}
        </p>
        <p class="text-lg font-semibold text-fg-primary">{props.value}</p>
      </div>
    </CardContent>
  </Card>
);

const UsageOverview: Component<{ query: GatewayQueryHandle<UsageSummary> }> = (props) => (
  <GatewayQuerySection
    label="7-day usage"
    query={props.query}
    isEmpty={() => false}
    loading={<LoadingRows rows={2} />}
    empty={null}
  >
    {(usage) => (
      <div class="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Spend (7d)" value={`$${usage.totalSpend.toFixed(4)}`} icon={DollarSign} />
        <StatCard label="Requests (7d)" value={usage.totalRequests.toLocaleString()} icon={Zap} />
      </div>
    )}
  </GatewayQuerySection>
);

const ProvidersContent: Component<{ providers: GatewayProvider[] }> = (props) => {
  const activeProviders = () => props.providers.filter((p) => p.isEnabled).length;

  return (
    <div class="space-y-24">
      <div class="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Providers" value={String(activeProviders())} icon={Server} />
      </div>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-12">
          <CardTitle class="flex items-center gap-8 text-base">
            <Server class="h-16 w-16 text-brand" size={16} />
            Provider Status
          </CardTitle>
          <A href="/gateway/providers" class="text-[13px] font-medium text-brand hover:underline">
            Manage →
          </A>
        </CardHeader>
        <CardContent>
          {props.providers.length === 0 ? (
            <p class="py-32 text-center text-sm text-fg-tertiary">
              No providers configured yet. Add one to start routing requests.
            </p>
          ) : (
            <div class="space-y-8">
              {props.providers.map((p) => (
                <div class="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-16 py-12">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-8">
                      <span class="truncate text-sm font-medium text-fg-primary">{p.name}</span>
                      <span class="rounded bg-muted px-6 py-2 font-mono text-[10px] uppercase text-fg-tertiary">
                        {p.type}
                      </span>
                    </div>
                    <p class="mt-2 truncate text-xs text-fg-tertiary">
                      {p.baseUrl} ·{" "}
                      {`${p.deploymentCount} deployment${p.deploymentCount === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <StatusBadge status={p.isEnabled ? p.status : "disabled"} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

const ProvidersOverview: Component<{ query: GatewayQueryHandle<GatewayProvider[]> }> = (props) => (
  <GatewayQuerySection
    label="gateway providers"
    query={props.query}
    isEmpty={() => false}
    loading={<LoadingRows rows={4} />}
    empty={null}
  >
    {(providers) => <ProvidersContent providers={providers} />}
  </GatewayQuerySection>
);

const QuickLinks: Component = () => (
  <Card>
    <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-12">
      <CardTitle class="flex items-center gap-8 text-base">
        <Boxes class="h-16 w-16 text-brand" size={16} />
        Quick Links
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div class="grid grid-cols-2 gap-12 sm:grid-cols-4">
        {[
          { to: "/gateway/models", label: "Models" },
          { to: "/gateway/usage", label: "Usage" },
          { to: "/gateway/logs", label: "Logs" },
        ].map((link) => (
          <A
            href={link.to}
            class="rounded-lg border border-border bg-surface-raised px-16 py-12 text-center text-sm font-medium text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary"
          >
            {link.label}
          </A>
        ))}
      </div>
    </CardContent>
  </Card>
);

/** Pure Gateway Overview view; query ownership remains in GatewayOverviewPage. */
export const GatewayOverviewContent: Component<{
  providersQuery: GatewayQueryHandle<GatewayProvider[]>;
  usageQuery: GatewayQueryHandle<UsageSummary>;
}> = (props) => (
  <div class="flex h-full flex-col">
    <PageHeaderShell title="Gateway" description="LLM proxy gateway overview." />
    <div class="flex-1 overflow-y-auto">
      <div class="space-y-24 p-24">
        <UsageOverview query={props.usageQuery} />
        <ProvidersOverview query={props.providersQuery} />
        <QuickLinks />
      </div>
    </div>
  </div>
);

export const GatewayOverviewPage: Component = () => {
  const { startDate, endDate } = last7Days();
  const providersQuery = useGwProvidersQuery();
  const usageQuery = useGwUsageSummaryQuery({ startDate, endDate });

  return (
    <GatewayProjectGate title="Gateway" description="LLM proxy gateway overview.">
      <GatewayOverviewContent providersQuery={providersQuery} usageQuery={usageQuery} />
    </GatewayProjectGate>
  );
};
