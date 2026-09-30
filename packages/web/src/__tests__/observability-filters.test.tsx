// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationsPage } from "@/features/observations/observations-page";
import { ScoresPage } from "@/features/scores/scores-page";
import { TracesPage } from "@/features/traces/traces-page";
import { listTraces } from "@/shared/lib/api";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";

type PageCase = {
  path: string;
  Page: ComponentType;
  initial: Record<string, string>;
  drafts: Record<string, string>;
  limit: string;
};

const cases: PageCase[] = [
  {
    path: "/traces",
    Page: TracesPage,
    initial: {
      fromTimestamp: "2026-09-01T00:00:00.000Z",
      toTimestamp: "2026-09-30T23:59:59.999Z",
    },
    drafts: {
      name: "chat & summarize",
      userId: "user-1",
      environment: "production",
      sessionId: "session/1",
      tags: "quality,release",
      version: "v2",
      release: "2026.09",
    },
    limit: "50",
  },
  {
    path: "/observations",
    Page: ObservationsPage,
    initial: {
      type: "GENERATION",
      level: "ERROR",
      fromStartTime: "2026-09-01T00:00:00.000Z",
      toStartTime: "2026-09-30T23:59:59.999Z",
    },
    drafts: {
      name: "generation",
      environment: "production",
      traceId: "trace/1",
      userId: "user-1",
      version: "v2",
      parentObservationId: "parent-1",
      model: "gpt-4.1",
    },
    limit: "25",
  },
  {
    path: "/scores",
    Page: ScoresPage,
    initial: {
      source: "API",
      dataType: "NUMERIC",
      operator: ">=",
      fromTimestamp: "2026-09-01T00:00:00.000Z",
      toTimestamp: "2026-09-30T23:59:59.999Z",
    },
    drafts: {
      name: "quality",
      environment: "production",
      traceId: "trace/1",
      userId: "user-1",
      configId: "config-1",
      value: "0",
    },
    limit: "25",
  },
];

const requests: URL[] = [];
const clients: QueryClient[] = [];

function LocationProbe({ path }: { path: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.search}</output>
      <button type="button" onClick={() => navigate(`${path}?name=external&userId=external-user`)}>
        External filters
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Forward
      </button>
    </>
  );
}

function renderPage(testCase: PageCase, initial: Record<string, string> = testCase.initial) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  clients.push(client);
  const params = new URLSearchParams({ page: "4", sort: "name.asc", tab: "retained", ...initial });
  const Page = testCase.Page;
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`${testCase.path}?${params}`]}>
        <Routes>
          <Route
            path={testCase.path}
            element={
              <>
                <Page />
                <LocationProbe path={testCase.path} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function locationParams() {
  return new URLSearchParams(screen.getByTestId("location").textContent ?? "");
}

function input(key: string) {
  const labels: Record<string, string> = {
    name: "Name",
    userId: "User ID",
    environment: "Environment",
    sessionId: "Session ID",
    tags: "Tags",
    version: "Version",
    release: "Release",
    traceId: "Trace ID",
    parentObservationId: "Parent observation ID",
    model: "Model",
    configId: "Config ID",
    value: "Value",
  };
  return screen.getByPlaceholderText(`Filter by ${labels[key]}…`) as HTMLInputElement;
}

beforeEach(() => {
  requests.length = 0;
  setProjectContext({
    projectId: "project-1",
    projectName: "Test",
    publicKey: "pk",
    secretKey: "sk",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("pk:sk")}`);
      const url = new URL(resource, "http://localhost");
      requests.push(url);
      return new Response(
        JSON.stringify({
          data: [],
          meta: {
            page: Number(url.searchParams.get("page")),
            limit: Number(url.searchParams.get("limit")),
            totalItems: 0,
            totalPages: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  clearProjectContext();
  vi.unstubAllGlobals();
});

describe.each(cases)("$path route filters", (testCase) => {
  it("submits every draft in one request, resets page, and preserves existing URL filters", async () => {
    renderPage(testCase);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].pathname).toBe(
      testCase.path === "/scores" ? "/api/public/v2/scores" : `/api/public${testCase.path}`,
    );
    expect(requests[0].searchParams.get("page")).toBe("4");
    for (const [key, value] of Object.entries(testCase.initial)) {
      expect(requests[0].searchParams.get(key)).toBe(key === "operator" ? null : value);
    }
    for (const [key, value] of Object.entries(testCase.drafts)) {
      fireEvent.change(input(key), { target: { value: key === "value" ? value : ` ${value} ` } });
    }
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    const request = requests[1];
    for (const [key, value] of Object.entries({ ...testCase.initial, ...testCase.drafts })) {
      expect(request.searchParams.get(key)).toBe(value);
      expect(locationParams().get(key)).toBe(value);
    }
    expect(request.searchParams.get("page")).toBe("1");
    expect(request.searchParams.get("limit")).toBe(testCase.limit);
    expect(locationParams().has("page")).toBe(false);
    expect(locationParams().get("sort")).toBe("name.asc");
    expect(locationParams().get("tab")).toBe("retained");
    if (testCase.path === "/traces") expect(request.searchParams.get("orderBy")).toBe("name.asc");

    fireEvent.change(input("name"), { target: { value: "unsubmitted" } });
    fireEvent.click(screen.getByRole("button", { name: /^Clear \(/ }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect([...requests[2].searchParams.keys()].sort()).toEqual(
      testCase.path === "/traces"
        ? ["limit", "orderBy", "page"]
        : testCase.path === "/observations"
          ? ["fields", "limit", "page"]
          : ["limit", "page"],
    );
    expect(Object.fromEntries(locationParams())).toEqual({ sort: "name.asc", tab: "retained" });
    for (const key of Object.keys(testCase.drafts)) expect(input(key).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(locationParams().has("name")).toBe(false);
  });

  it("Enter submits multiple drafts atomically and navigation restores URL-backed inputs", async () => {
    renderPage(testCase, { name: "original", userId: "original-user" });
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.change(input("name"), { target: { value: "updated" } });
    fireEvent.change(input("userId"), { target: { value: "updated-user" } });
    fireEvent.keyDown(input("name"), { key: "Enter" });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].searchParams.get("name")).toBe("updated");
    expect(requests[1].searchParams.get("userId")).toBe("updated-user");

    fireEvent.click(screen.getByRole("button", { name: "External filters" }));
    await waitFor(() => expect(input("name").value).toBe("external"));
    expect(input("userId").value).toBe("external-user");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(input("name").value).toBe("updated"));
    expect(input("userId").value).toBe("updated-user");
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(input("name").value).toBe("external"));
  });

  it("clears uncommitted drafts even when no URL filter is active", async () => {
    renderPage(testCase, {});
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.change(input("name"), { target: { value: "draft only" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear (0)" }));
    expect(input("name").value).toBe("");
    expect(locationParams().has("page")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(locationParams().has("name")).toBe(false);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].searchParams.has("name")).toBe(false);
  });
});

it("serializes trace tag arrays as repeated backend query parameters", async () => {
  await listTraces({ tags: ["quality", "release & test"], version: "v2", release: "2026.09" });
  expect(requests[0].searchParams.getAll("tags")).toEqual(["quality", "release & test"]);
  expect(requests[0].searchParams.get("version")).toBe("v2");
  expect(requests[0].searchParams.get("release")).toBe("2026.09");
});

it.each([undefined, "<", ">", "<=", ">=", "!=", "="])(
  "uses numeric input and sends operator %s only when the score threshold is set",
  async (operator) => {
    const scoreCase = cases.find((testCase) => testCase.path === "/scores");
    if (!scoreCase) throw new Error("Scores route case is missing");
    renderPage(scoreCase, operator ? { operator } : {});
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].searchParams.has("operator")).toBe(false);
    expect(input("value").type).toBe("number");
    expect(input("value").step).toBe("any");
    if (!operator) expect(screen.getByTitle(/^Numeric comparison/).textContent).toBe("=");
    fireEvent.change(input("value"), { target: { value: "-0.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].searchParams.get("value")).toBe("-0.25");
    expect(requests[1].searchParams.get("operator")).toBe(operator ?? "=");
    fireEvent.click(screen.getByRole("button", { name: "Clear Value" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].searchParams.has("value")).toBe(false);
    expect(requests[2].searchParams.has("operator")).toBe(false);
  },
);

it("explains all-tags matching and exact trace filters using readable labels", async () => {
  renderPage(cases[0], {});
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(input("sessionId").title).toBe("Exact session ID match");
  expect(input("version").title).toBe("Exact version match");
  expect(input("release").title).toBe("Exact release match");
  expect(input("tags").title).toBe("Comma-separated tags; traces must contain all tags");
  expect(input("userId").title).toBe("User ID contains this text");
});

it("explains exact observation model, version and related ID matching", async () => {
  renderPage(cases[1], {});
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(input("model").title).toBe("Exact model name match");
  expect(input("version").title).toBe("Exact version match");
  expect(input("traceId").title).toBe("Exact trace ID match");
  expect(input("parentObservationId").title).toBe("Exact parent observation ID match");
  expect(input("userId").title).toBe("Exact trace user ID match");
});
