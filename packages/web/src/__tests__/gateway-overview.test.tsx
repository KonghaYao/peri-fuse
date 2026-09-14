import { Route, Router } from "@solidjs/router";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { GatewayOverviewContent } from "@/features/gateway/gateway-overview-page";
import type { GatewayProvider, UsageSummary } from "@/shared/lib/gateway-api";
import { gatewayQuery } from "./gateway-query-test-helpers";

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    totalSpend: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    ...overrides,
  };
}

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "provider-1",
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com",
    isEnabled: true,
    status: "healthy",
    cooldownUntil: null,
    budgetLimit: null,
    budgetPeriod: null,
    budgetSpend: 0,
    budgetResetAt: null,
    deploymentCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderOverview(
  providersQuery = gatewayQuery<GatewayProvider[]>([]),
  usageQuery = gatewayQuery<UsageSummary>(summary()),
) {
  const view = render(() => (
    <Router root={(props) => <>{props.children}</>}>
      <Route
        path="*"
        component={() => (
          <GatewayOverviewContent providersQuery={providersQuery} usageQuery={usageQuery} />
        )}
      />
    </Router>
  ));
  return view.container.innerHTML;
}

describe("Gateway Overview query states", () => {
  it("keeps the overview and successful usage visible when providers fail", () => {
    const html = renderOverview(
      gatewayQuery<GatewayProvider[]>(undefined, {
        error: new Error("providers unavailable"),
        isPending: false,
        isFetching: false,
      }),
      gatewayQuery(summary({ totalSpend: 12, totalRequests: 1234 })),
    );

    expect(html).toContain("LLM proxy gateway overview.");
    expect(html).toContain("Quick Links");
    expect(html).toContain("$12.0000");
    expect(html).toContain((1234).toLocaleString());
    expect(html).toContain("Could not load gateway providers.");
  });

  it("keeps the overview and successful providers visible when usage fails", () => {
    const html = renderOverview(
      gatewayQuery([provider()]),
      gatewayQuery<UsageSummary>(undefined, {
        error: new Error("usage unavailable"),
        isPending: false,
        isFetching: false,
      }),
    );

    expect(html).toContain("Quick Links");
    expect(html).toContain("OpenAI");
    expect(html).toContain("Could not load 7-day usage.");
  });

  it("distinguishes initial loading, provider empty, and zero usage", () => {
    const loadingHtml = renderOverview(
      gatewayQuery<GatewayProvider[]>(undefined),
      gatewayQuery<UsageSummary>(undefined),
    );
    expect(loadingHtml).toContain('aria-label="Loading gateway providers"');
    expect(loadingHtml).toContain('aria-label="Loading 7-day usage"');
    expect(loadingHtml).toContain("Quick Links");

    const emptyHtml = renderOverview();
    expect(emptyHtml).toContain("No providers configured yet. Add one to start routing requests.");
    expect(emptyHtml).toContain("$0.0000");
    expect(emptyHtml).toContain("Requests (7d)");
    expect(emptyHtml).toContain("Active Providers");
    expect(emptyHtml.match(/>0<\/p>/g)).toHaveLength(2);
  });

  it("keeps cached empty providers and usage visible during refresh states", () => {
    const html = renderOverview(
      gatewayQuery<GatewayProvider[]>([], { error: new Error("provider refresh failed") }),
      gatewayQuery(summary({ totalSpend: 3, totalRequests: 4 }), { isFetching: true }),
    );

    expect(html).toContain("Could not refresh gateway providers; showing previous data.");
    expect(html).toContain("No providers configured yet. Add one to start routing requests.");
    expect(html).toContain("$3.0000");
    expect(html).toContain("Refreshing 7-day usage");

    const populatedHtml = renderOverview(
      gatewayQuery([provider({ name: "cached-provider" })], {
        error: new Error("provider refresh failed"),
      }),
    );
    expect(populatedHtml).toContain("cached-provider");
    expect(populatedHtml).toContain("Could not refresh gateway providers; showing previous data.");
  });

  it("routes provider retry once without retrying usage", () => {
    const providersQuery = gatewayQuery<GatewayProvider[]>(undefined, {
      error: new Error("providers unavailable"),
      isPending: false,
      isFetching: false,
    });
    const usageQuery = gatewayQuery<UsageSummary>(undefined, {
      error: new Error("usage unavailable"),
      isPending: false,
      isFetching: false,
    });

    const html = renderOverview(providersQuery, usageQuery);
    expect(html).toContain('aria-label="Retry gateway providers"');

    const retryButton = html.match(/aria-label="Retry gateway providers"/);
    expect(retryButton).toBeTruthy();
    void providersQuery.refetch();
    expect(providersQuery.refetch).toHaveBeenCalledOnce();
    expect(usageQuery.refetch).not.toHaveBeenCalled();

    const pendingHtml = renderOverview({ ...providersQuery, isFetching: true }, usageQuery);
    expect(pendingHtml).toContain("Retrying…");
    expect(pendingHtml).toContain("disabled");
  });

  it("keeps the page header and exactly three quick links when both queries fail", () => {
    const html = renderOverview(
      gatewayQuery<GatewayProvider[]>(undefined, {
        error: new Error("providers unavailable"),
        isPending: false,
        isFetching: false,
      }),
      gatewayQuery<UsageSummary>(undefined, {
        error: new Error("usage unavailable"),
        isPending: false,
        isFetching: false,
      }),
    );

    expect(html).toContain("LLM proxy gateway overview.");
    expect(html.match(/href="\/gateway\/(models|usage|logs)"/g)).toHaveLength(3);
    expect(html).toContain("Could not load gateway providers.");
    expect(html).toContain("Could not load 7-day usage.");
  });

  it("preserves provider status, management, and deployment details", () => {
    const html = renderOverview(
      gatewayQuery([
        provider({ name: "active-provider", deploymentCount: 1 }),
        provider({
          id: "provider-2",
          name: "disabled-provider",
          isEnabled: false,
          deploymentCount: 2,
        }),
      ]),
    );

    expect(html).toContain("active-provider");
    expect(html).toContain("disabled-provider");
    expect(html).toContain(">healthy</span>");
    expect(html).toContain(">disabled</span>");
    expect(html).toContain("1 deployment");
    expect(html).toContain("2 deployments");
    expect(html).toContain('href="/gateway/providers"');
    expect(html).toContain("Manage →");
  });
});
