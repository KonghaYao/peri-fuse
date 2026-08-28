/**
 * Gateway Overview — stat cards + provider status list.
 */
import { Boxes, DollarSign, Server, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import {
  type GatewayQueryHandle,
  GatewayQuerySection,
} from "@/features/gateway/components/gateway-query-section";
import { StatusBadge } from "@/features/gateway/components/status-badge";
import { EmptyState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
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

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof DollarSign;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-subtle">
          <Icon className="h-4 w-4 text-brand" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
            {label}
          </p>
          <p className="text-lg font-semibold text-fg-primary">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageOverview({ query }: { query: GatewayQueryHandle<UsageSummary> }) {
  return (
    <GatewayQuerySection
      label="7-day usage"
      query={query}
      isEmpty={() => false}
      loading={<LoadingRows rows={2} />}
      empty={null}
    >
      {(usage) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Spend (7d)"
            value={`$${usage.totalSpend.toFixed(4)}`}
            icon={DollarSign}
          />
          <StatCard label="Requests (7d)" value={usage.totalRequests.toLocaleString()} icon={Zap} />
        </div>
      )}
    </GatewayQuerySection>
  );
}

function ProvidersOverview({ query }: { query: GatewayQueryHandle<GatewayProvider[]> }) {
  return (
    <GatewayQuerySection
      label="gateway providers"
      query={query}
      isEmpty={() => false}
      loading={<LoadingRows rows={4} />}
      empty={null}
    >
      {(providers) => <ProvidersContent providers={providers} />}
    </GatewayQuerySection>
  );
}

function ProvidersContent({ providers }: { providers: GatewayProvider[] }) {
  const activeProviders = providers.filter((p) => p.isEnabled).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Providers" value={String(activeProviders)} icon={Server} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4 text-brand" />
            Provider Status
          </CardTitle>
          <Link
            to="/gateway/providers"
            className="text-[13px] font-medium text-brand hover:underline"
          >
            Manage →
          </Link>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <EmptyState message="No providers configured yet. Add one to start routing requests." />
          ) : (
            <div className="space-y-2">
              {providers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg-primary">{p.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-tertiary">
                        {p.type}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-fg-tertiary">
                      {p.baseUrl} · {p.deploymentCount} deployment
                      {p.deploymentCount === 1 ? "" : "s"}
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
}

function QuickLinks() {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="h-4 w-4 text-brand" />
          Quick Links
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { to: "/gateway/models", label: "Models" },
            { to: "/gateway/usage", label: "Usage" },
            { to: "/gateway/logs", label: "Logs" },
          ].map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="rounded-lg border border-border bg-surface-raised px-4 py-3 text-center text-sm font-medium text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Pure Gateway Overview view; query ownership remains in GatewayOverviewPage. */
export function GatewayOverviewContent({
  providersQuery,
  usageQuery,
}: {
  providersQuery: GatewayQueryHandle<GatewayProvider[]>;
  usageQuery: GatewayQueryHandle<UsageSummary>;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Gateway" description="LLM proxy gateway overview." />
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-6 p-6">
          <UsageOverview query={usageQuery} />
          <ProvidersOverview query={providersQuery} />
          <QuickLinks />
        </div>
      </div>
    </div>
  );
}

export function GatewayOverviewPage() {
  const { startDate, endDate } = last7Days();
  const providersQuery = useGwProvidersQuery();
  const usageQuery = useGwUsageSummaryQuery({ startDate, endDate });

  return <GatewayOverviewContent providersQuery={providersQuery} usageQuery={usageQuery} />;
}
