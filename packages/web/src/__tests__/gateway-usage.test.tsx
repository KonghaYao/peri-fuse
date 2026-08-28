import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageQuerySection } from "@/features/gateway/components/usage-query-section";
import {
  resolveUsageQueryState,
  type UsageQuerySnapshot,
} from "@/features/gateway/components/usage-query-state";
import { GatewayUsageContent } from "@/features/gateway/gateway-usage-page";
import type {
  DailySpendRow,
  UsageByModelRow,
  UsageByProviderRow,
  UsageSummary,
} from "@/shared/lib/gateway-api";

interface TestQuery<T> extends UsageQuerySnapshot<T> {
  refetch: () => Promise<unknown>;
}

function query<T>(
  data: T | undefined,
  overrides: Partial<UsageQuerySnapshot<T>> = {},
): TestQuery<T> {
  return {
    data,
    error: null,
    isPending: data === undefined,
    isFetching: data === undefined,
    refetch: vi.fn(async () => undefined),
    ...overrides,
  };
}

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

function pageProps(overrides: Record<string, unknown> = {}) {
  return {
    range: { start: "2026-08-01", end: "2026-08-08" },
    onStartDateChange: vi.fn(),
    onEndDateChange: vi.fn(),
    summaryQuery: query<UsageSummary>(summary()),
    dailyQuery: query<DailySpendRow[]>([]),
    byModelQuery: query<UsageByModelRow[]>([]),
    byProviderQuery: query<UsageByProviderRow[]>([]),
    ...overrides,
  };
}

function elements(node: ReactNode): ReactElement[] {
  const found: ReactElement[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    found.push(child);
    found.push(...elements((child.props as { children?: ReactNode }).children));
  });
  return found;
}

function renderFunctionElement(node: ReactNode): ReactNode {
  if (!isValidElement(node)) {
    throw new Error("Expected a function component element");
  }
  const { type, props } = node;
  if (typeof type !== "function") throw new Error("Expected a function component element");
  return (type as (componentProps: typeof props) => ReactNode)(props);
}

describe("resolveUsageQueryState", () => {
  it("keeps initial loading distinct from an empty result", () => {
    expect(
      resolveUsageQueryState(query<unknown[]>(undefined), (rows) => rows.length === 0),
    ).toEqual({ kind: "loading", isFetching: true });
  });

  it("keeps an unavailable result distinct from an empty result", () => {
    const error = new Error("usage unavailable");
    expect(
      resolveUsageQueryState(
        query<unknown[]>(undefined, { error, isPending: false, isFetching: false }),
        (rows) => rows.length === 0,
      ),
    ).toEqual({ kind: "error", error, isFetching: false });
  });

  it("preserves cached data while a refresh is active or failed", () => {
    const error = new Error("refresh failed");
    expect(
      resolveUsageQueryState(query(["gpt-5"], { isFetching: true }), (rows) => rows.length === 0),
    ).toMatchObject({ kind: "content", data: ["gpt-5"], isFetching: true });
    expect(
      resolveUsageQueryState(query(["gpt-5"], { error }), (rows) => rows.length === 0),
    ).toMatchObject({ kind: "content", data: ["gpt-5"], staleError: error });
  });
});

describe("Gateway Usage async states", () => {
  it("renders mixed query outcomes independently", () => {
    const html = renderToStaticMarkup(
      <GatewayUsageContent
        {...pageProps({
          summaryQuery: query<UsageSummary>(undefined, {
            error: new Error("summary unavailable"),
            isPending: false,
            isFetching: false,
          }),
          dailyQuery: query<DailySpendRow[]>(undefined),
          byModelQuery: query<UsageByModelRow[]>([]),
          byProviderQuery: query<UsageByProviderRow[]>([
            {
              provider: "OpenAI",
              totalSpend: 1,
              totalPromptTokens: 2,
              totalCompletionTokens: 3,
              totalRequests: 4,
            },
          ]),
        })}
      />,
    );

    expect(html).toContain("Could not load usage summary.");
    expect(html).toContain('aria-label="Loading daily usage"');
    expect(html.match(/No usage data in this range\./g)).toHaveLength(1);
    expect(html).toContain("OpenAI");
  });

  it("routes one retry to only the failed section and exposes its pending state", () => {
    const summaryQuery = query<UsageSummary>(undefined, {
      error: new Error("summary unavailable"),
      isPending: false,
      isFetching: false,
    });
    const providerQuery = query<UsageByProviderRow[]>(undefined, {
      error: new Error("provider unavailable"),
      isPending: false,
      isFetching: false,
    });
    const content = GatewayUsageContent(
      pageProps({ summaryQuery, byProviderQuery: providerQuery }),
    );
    const summarySection = elements(content).find(
      (element) =>
        element.type === UsageQuerySection &&
        (element.props as { label?: string }).label === "usage summary",
    );
    const failure = renderFunctionElement(renderFunctionElement(summarySection));
    const retry = elements(failure).find(
      (element) =>
        (element.props as { "aria-label"?: string })["aria-label"] === "Retry usage summary",
    );

    expect(retry).toBeDefined();
    if (!retry) throw new Error("Expected the usage summary retry button");
    (retry.props as { onClick: () => void }).onClick();
    expect(summaryQuery.refetch).toHaveBeenCalledOnce();
    expect(providerQuery.refetch).not.toHaveBeenCalled();

    const pendingHtml = renderToStaticMarkup(
      <UsageQuerySection
        label="usage summary"
        query={{ ...summaryQuery, isFetching: true }}
        isEmpty={() => false}
        loading={null}
        empty={null}
      >
        {() => null}
      </UsageQuerySection>,
    );
    expect(pendingHtml).toContain("disabled");
    expect(pendingHtml).toContain("Retrying…");
  });

  it("keeps both date controls available when every query is loading or failed", () => {
    const html = renderToStaticMarkup(
      <GatewayUsageContent
        {...pageProps({
          summaryQuery: query<UsageSummary>(undefined),
          dailyQuery: query<DailySpendRow[]>(undefined, {
            error: new Error("daily unavailable"),
            isPending: false,
            isFetching: false,
          }),
          byModelQuery: query<UsageByModelRow[]>(undefined),
          byProviderQuery: query<UsageByProviderRow[]>(undefined, {
            error: new Error("provider unavailable"),
            isPending: false,
            isFetching: false,
          }),
        })}
      />,
    );

    expect(html).toContain('for="gateway-usage-from"');
    expect(html).toContain('id="gateway-usage-from"');
    expect(html).toContain('for="gateway-usage-to"');
    expect(html).toContain('id="gateway-usage-to"');
  });

  it("keeps cached content visible while refreshing or after a refresh failure", () => {
    const html = renderToStaticMarkup(
      <GatewayUsageContent
        {...pageProps({
          byModelQuery: query<UsageByModelRow[]>(
            [
              {
                model: "gpt-refreshing",
                modelGroup: null,
                totalSpend: 1,
                totalPromptTokens: 2,
                totalCompletionTokens: 3,
                totalRequests: 4,
              },
            ],
            { isFetching: true },
          ),
          byProviderQuery: query<UsageByProviderRow[]>(
            [
              {
                provider: "cached-provider",
                totalSpend: 1,
                totalPromptTokens: 2,
                totalCompletionTokens: 3,
                totalRequests: 4,
              },
            ],
            { error: new Error("refresh failed") },
          ),
        })}
      />,
    );

    expect(html).toContain("gpt-refreshing");
    expect(html).toContain("Refreshing usage by model");
    expect(html).toContain("cached-provider");
    expect(html).toContain("Could not refresh usage by provider; showing previous data.");
  });

  it("renders a zero-valued summary as real content", () => {
    const html = renderToStaticMarkup(<GatewayUsageContent {...pageProps()} />);

    expect(html).toContain("$0.0000");
    expect(html.match(/>0<\/p>/g)).toHaveLength(2);
    expect(html).toContain(">—</p>");
  });
});
