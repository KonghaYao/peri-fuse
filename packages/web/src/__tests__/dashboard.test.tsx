import { fireEvent, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { queryParamsForRange, resolveRange } from "@/features/dashboard/range-presets";
import type { Dashboard } from "@/shared/lib/types";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

const sampleDashboard: Dashboard = {
  summary: {
    totalTraces: 120,
    totalObservations: 480,
    totalGenerations: 96,
    totalScores: 12,
    totalCost: 0.42,
    totalTokens: 125_000,
    inputTokens: 80_000,
    outputTokens: 45_000,
    totalCachedTokens: 12_000,
    cacheHitRate: 0.15,
    totalUsers: 4,
    avgLatencyMs: 820,
    p50LatencyMs: 640,
    p95LatencyMs: 2100,
    errorCount: 3,
    errorRate: 0.025,
  },
  daily: [
    {
      date: "2026-01-10",
      traces: 12,
      observations: 48,
      tokens: 12_500,
      avgLatencyMs: 800,
      p95LatencyMs: 2000,
      errors: 1,
      cacheHitRate: 0.12,
      avgScore: 0.82,
    },
  ],
  byModel: [
    {
      model: "gpt-4o-mini",
      observations: 40,
      tokens: 50_000,
      avgLatencyMs: 700,
      p50LatencyMs: 600,
      p95LatencyMs: 1800,
    },
  ],
  levels: [
    { level: "DEFAULT", count: 400 },
    { level: "ERROR", count: 3 },
  ],
  topUsers: [{ userId: "user-1", traces: 20, tokens: 30_000 }],
  recentErrors: [
    {
      id: "obs-err-1",
      name: "Tool failure",
      type: "GENERATION",
      startTime: "2026-01-10T12:00:00.000Z",
      statusMessage: "Upstream timeout",
      traceId: "trace-1",
      model: "gpt-4o-mini",
    },
  ],
};

function mockDashboardFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? `${input.pathname}${input.search}`
          : input.url;
    const url = raw.replace(/^https?:\/\/[^/]+/, "");
    return handler(url);
  });
}

describe("DashboardPage", () => {
  beforeEach(() => {
    clearProjectContext();
    localStorage.clear();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading then KPI cards", async () => {
    vi.stubGlobal(
      "fetch",
      mockDashboardFetch((url) => {
        if (url.startsWith("/api/public/dashboard")) {
          return jsonResponse(sampleDashboard);
        }
        return jsonResponse({ message: "Not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <DashboardPage />);

    await waitFor(() => {
      expect(view.getByText("120")).toBeTruthy();
      expect(view.getByText("Activity")).toBeTruthy();
      expect(view.getByText("Tool failure")).toBeTruthy();
    });
  });

  it("shows error state with retry", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      mockDashboardFetch((url) => {
        if (!url.startsWith("/api/public/dashboard")) {
          return jsonResponse({ message: "Not found" }, { status: 404 });
        }
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse({ message: "Server unavailable" }, { status: 500 });
        }
        return jsonResponse(sampleDashboard);
      }),
    );

    const view = renderWithProviders(() => <DashboardPage />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(view.getByText("120")).toBeTruthy();
    });
  });

  it("maps URL range presets to dashboard query params", () => {
    expect(resolveRange(undefined)).toBe("30d");
    expect(resolveRange("7d")).toBe("7d");
    expect(resolveRange(["24h"])).toBe("24h");
    expect(resolveRange("invalid")).toBe("30d");
    expect(resolveRange("bogus")).toBe("30d");

    const sevenDay = queryParamsForRange("7d");
    expect(sevenDay.from).toBeTruthy();
    expect(queryParamsForRange("all")).toEqual({});
  });
});
