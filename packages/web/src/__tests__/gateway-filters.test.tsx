/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFilteredRequests } from "@/features/gateway/components/gateway-filter-queries";
import {
  GatewayFilters,
  GatewayPagination,
  isValidDuration,
  logDateFilters,
  useGatewayFilters,
} from "@/features/gateway/components/gateway-filters";
import { GatewayLogsPage } from "@/features/gateway/gateway-logs-page";

vi.mock("@/features/gateway/components/gateway-filter-queries", () => ({
  useFilteredRequests: vi.fn(() => ({
    data: { data: [], total: 120 },
    isLoading: false,
    isFetching: false,
    error: null,
  })),
  useFilteredErrors: vi.fn(() => ({
    data: {
      data: [
        {
          id: "error",
          modelGroup: "alias",
          providerModel: "upstream",
          statusCode: "429",
          exceptionType: "RateLimitError",
          exceptionString: "slow down",
          startTime: "2026-09-29T12:00:00.000Z",
        },
      ],
      total: 1,
    },
    isLoading: false,
    isFetching: false,
    error: null,
  })),
}));

function LocationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="url">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

function FilterHarness() {
  const filters = useGatewayFilters("requests");
  return (
    <>
      <GatewayFilters
        filters={filters}
        fields={[
          { name: "model", label: "Model (exact)" },
          { name: "minDurationMs", label: "Minimum duration (ms)", type: "number" },
        ]}
      />
      <GatewayPagination filters={filters} total={120} pageSize={50} />
      <LocationControls />
    </>
  );
}

function UsageDefaultsHarness() {
  const filters = useGatewayFilters("usage", { startDate: "2026-09-23", endDate: "2026-09-30" });
  return (
    <>
      <GatewayFilters
        filters={filters}
        fields={[
          { name: "startDate", label: "From (UTC)", type: "date" },
          { name: "endDate", label: "To (UTC, inclusive)", type: "date" },
        ]}
      />
      <LocationControls />
    </>
  );
}

function currentSearch() {
  return new URLSearchParams(screen.getByTestId("url").textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Gateway filter URL and pagination lifecycle", () => {
  it("retains default dates for model-only URLs and respects explicitly empty dates", () => {
    const view = render(
      <MemoryRouter initialEntries={["/?usage.model=upstream"]}>
        <UsageDefaultsHarness />
      </MemoryRouter>,
    );
    expect(currentSearch().get("usage.model")).toBe("upstream");
    expect(currentSearch().get("usage.startDate")).toBe("2026-09-23");
    expect(currentSearch().get("usage.endDate")).toBe("2026-09-30");
    view.unmount();
    render(
      <MemoryRouter initialEntries={["/?usage.model=upstream&usage.startDate=&usage.endDate="]}>
        <UsageDefaultsHarness />
      </MemoryRouter>,
    );
    expect(currentSearch().get("usage.startDate")).toBe("");
    expect(currentSearch().get("usage.endDate")).toBe("");
  });

  it("synchronizes the seven-day default once and preserves unbounded clear across remount", () => {
    const view = render(
      <MemoryRouter initialEntries={["/?keep=value"]}>
        <UsageDefaultsHarness />
      </MemoryRouter>,
    );
    expect(currentSearch().get("usage.startDate")).toBe("2026-09-23");
    expect(currentSearch().get("usage.endDate")).toBe("2026-09-30");
    fireEvent.click(screen.getByText("Clear filters"));
    expect(currentSearch().has("usage.startDate")).toBe(false);
    expect(currentSearch().has("usage.endDate")).toBe(false);
    expect(currentSearch().get("usage.range")).toBe("all");
    expect(currentSearch().get("keep")).toBe("value");
    const cleared = `/?${currentSearch()}`;
    view.unmount();
    render(
      <MemoryRouter initialEntries={[cleared]}>
        <UsageDefaultsHarness />
      </MemoryRouter>,
    );
    expect((screen.getByLabelText("From (UTC)") as HTMLInputElement).value).toBe("");
    expect(currentSearch().has("usage.startDate")).toBe(false);
  });

  it("restores URL filters, applies atomically, resets pagination, and preserves unrelated parameters", () => {
    render(
      <MemoryRouter
        initialEntries={["/?requests.model=old&requests.offset=50&errors.offset=100&keep=value"]}
      >
        <FilterHarness />
      </MemoryRouter>,
    );
    const model = screen.getByLabelText("Model (exact)") as HTMLInputElement;
    expect(model.value).toBe("old");
    expect(model.title).toContain("Exact match");
    fireEvent.change(model, { target: { value: "new" } });
    expect(currentSearch().get("requests.model")).toBe("old");
    fireEvent.click(screen.getByText("Apply filters"));
    expect(currentSearch().get("requests.model")).toBe("new");
    expect(currentSearch().has("requests.offset")).toBe(false);
    expect(currentSearch().get("errors.offset")).toBe("100");
    expect(currentSearch().get("keep")).toBe("value");
    fireEvent.click(screen.getByText("Next"));
    expect(currentSearch().get("requests.offset")).toBe("50");
    fireEvent.click(screen.getByText("Back"));
    expect(currentSearch().has("requests.offset")).toBe(false);
    fireEvent.click(screen.getByText("Back"));
    expect(model.value).toBe("old");
    expect(currentSearch().get("requests.offset")).toBe("50");
  });

  it("clears draft, URL filters and pagination without clearing the other tab", () => {
    render(
      <MemoryRouter
        initialEntries={["/?requests.model=old&requests.offset=100&errors.statusCode=429"]}
      >
        <FilterHarness />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Model (exact)"), { target: { value: "draft" } });
    fireEvent.click(screen.getByText("Clear filters"));
    expect((screen.getByLabelText("Model (exact)") as HTMLInputElement).value).toBe("");
    expect(currentSearch().has("requests.model")).toBe(false);
    expect(currentSearch().has("requests.offset")).toBe(false);
    expect(currentSearch().get("errors.statusCode")).toBe("429");
    expect((screen.getByText("Previous") as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows intermediate number editing but prevents invalid submission and permits clearing", () => {
    render(
      <MemoryRouter initialEntries={["/?requests.minDurationMs=100"]}>
        <FilterHarness />
      </MemoryRouter>,
    );
    const duration = screen.getByLabelText("Minimum duration (ms)");
    for (const value of ["-", "NaN", "1.5", "1e3", "9007199254740992"]) {
      fireEvent.change(duration, { target: { value } });
      fireEvent.click(screen.getByText("Apply filters"));
      expect(screen.getByRole("alert").textContent).toContain("safe integer");
      expect(currentSearch().get("requests.minDurationMs")).toBe("100");
    }
    fireEvent.change(duration, { target: { value: "250" } });
    fireEvent.click(screen.getByText("Apply filters"));
    expect(currentSearch().get("requests.minDurationMs")).toBe("250");
    fireEvent.change(duration, { target: { value: "" } });
    fireEvent.click(screen.getByText("Apply filters"));
    expect(currentSearch().has("requests.minDurationMs")).toBe(false);
  });

  it("converts inclusive UTC date boundaries and validates integer durations", () => {
    expect(logDateFilters({ startDate: "2026-09-28", endDate: "2026-09-29" })).toEqual({
      startDate: "2026-09-28T00:00:00.000Z",
      endDate: "2026-09-29T23:59:59.999Z",
    });
    expect(logDateFilters({})).toEqual({});
    expect(isValidDuration("0")).toBe(true);
    expect(isValidDuration("")).toBe(true);
    expect(isValidDuration("NaN")).toBe(false);
  });

  it("keeps invalid URL durations editable without issuing an enabled request", () => {
    render(
      <MemoryRouter initialEntries={["/?requests.minDurationMs=NaN"]}>
        <GatewayLogsPage />
        <LocationControls />
      </MemoryRouter>,
    );
    expect(vi.mocked(useFilteredRequests).mock.calls.at(-1)?.[1]).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Edit the filter");
    fireEvent.change(screen.getByLabelText("Minimum duration (ms)"), { target: { value: "200" } });
    expect(vi.mocked(useFilteredRequests).mock.calls.at(-1)?.[1]).toBe(false);
    fireEvent.click(screen.getByText("Apply filters"));
    expect(vi.mocked(useFilteredRequests).mock.calls.at(-1)?.[1]).toBe(true);
    expect(vi.mocked(useFilteredRequests).mock.calls.at(-1)?.[0].minDurationMs).toBe(200);
  });

  it("restores the error tab and renders HTTP string status and real exception fields", () => {
    render(
      <MemoryRouter initialEntries={["/?logs.tab=errors&errors.statusCode=429"]}>
        <GatewayLogsPage />
      </MemoryRouter>,
    );
    expect((screen.getByLabelText("HTTP status (100–599)") as HTMLInputElement).value).toBe("429");
    expect(screen.getByText("slow down")).toBeTruthy();
    expect(screen.getByText("upstream")).toBeTruthy();
    expect(screen.getByText("429")).toBeTruthy();
  });
});
