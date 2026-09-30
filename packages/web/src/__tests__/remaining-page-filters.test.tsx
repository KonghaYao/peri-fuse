// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { ErrorsPage } from "@/features/errors/errors-page";
import { SessionsPage } from "@/features/sessions/sessions-page";
import { UsersPage } from "@/features/users/users-page";
import {
  useDashboardQuery,
  useErrorsQuery,
  useSessionsQuery,
  useUsersQuery,
} from "@/shared/hooks/queries";

vi.mock("@/shared/hooks/queries", () => ({
  useDashboardQuery: vi.fn(),
  useErrorsQuery: vi.fn(),
  useSessionsQuery: vi.fn(),
  useUsersQuery: vi.fn(),
}));
vi.mock("@/shared/components/auto-refresh-control", () => ({ AutoRefreshControl: () => null }));
vi.mock("@/features/sessions/session-search-dialog", () => ({ SessionSearchDialog: () => null }));
vi.mock("@/shared/components/data-table", () => ({
  DataTable: ({ toolbar }: { toolbar: ReactNode }) => <div>{toolbar}</div>,
}));
vi.mock("@/shared/components/date-filter-input", () => ({
  DateFilterInput: ({
    value,
    onCommit,
    title,
  }: {
    value?: string;
    onCommit: (value?: string) => void;
    title: string;
  }) => (
    <input
      aria-label={title}
      value={value ?? ""}
      onChange={(event) => onCommit(event.target.value || undefined)}
    />
  ),
}));

function Location() {
  const [params] = useSearchParams();
  return <output data-testid="location">{params.toString()}</output>;
}

function mount(page: ReactNode, url = "/") {
  render(
    <MemoryRouter initialEntries={[url]}>
      {page}
      <Location />
    </MemoryRouter>,
  );
}

function params() {
  return new URLSearchParams(screen.getByTestId("location").textContent ?? "");
}

function draft(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

beforeEach(() => {
  vi.mocked(useSessionsQuery).mockReturnValue({
    isLoading: false,
  } as ReturnType<typeof useSessionsQuery>);
  vi.mocked(useUsersQuery).mockReturnValue({ isLoading: false } as ReturnType<
    typeof useUsersQuery
  >);
  vi.mocked(useErrorsQuery).mockReturnValue({ isLoading: false } as ReturnType<
    typeof useErrorsQuery
  >);
  vi.mocked(useDashboardQuery).mockReturnValue({ isLoading: false } as ReturnType<
    typeof useDashboardQuery
  >);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("remaining page server filters", () => {
  it("submits session ID, a single literal tag and all drafts atomically; resets paging", () => {
    mount(<SessionsPage />, "/sessions?page=3&sort=id.asc&keep=1");
    draft("Exact session ID…", " session-1 ");
    draft("Exact trace tag…", "team,blue");
    draft("Filter by userId…", "user-1");
    draft("Filter by environment…", "prod");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(Object.fromEntries(params())).toEqual({
      sessionId: "session-1",
      tags: "team,blue",
      userId: "user-1",
      environment: "prod",
      sort: "id.asc",
      keep: "1",
    });
    expect(useSessionsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        sessionId: "session-1",
        tags: "team,blue",
        userId: "user-1",
        environment: "prod",
      }),
    );
    draft("Exact trace tag…", "unsubmitted");
    fireEvent.click(screen.getByRole("button", { name: "Clear (4)" }));
    expect(Object.fromEntries(params())).toEqual({ sort: "id.asc", keep: "1" });
    for (const placeholder of [
      "Exact session ID…",
      "Exact trace tag…",
      "Filter by userId…",
      "Filter by environment…",
    ]) {
      expect((screen.getByPlaceholderText(placeholder) as HTMLInputElement).value).toBe("");
    }
  });

  it("submits users drafts together and clears an uncommitted environment", () => {
    mount(<UsersPage />, "/users?page=2&userId=old&keep=1");
    draft("Filter by user id…", "new-user");
    draft("Filter by environment…", "staging");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(useUsersQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        userId: "new-user",
        environment: "staging",
      }),
    );
    draft("Filter by environment…", "unsubmitted");
    fireEvent.click(screen.getByRole("button", { name: "Clear (2)" }));
    expect(params().get("keep")).toBe("1");
    expect((screen.getByPlaceholderText("Filter by environment…") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("sends error identities to the server together and clears selection and drafts", () => {
    mount(<ErrorsPage />, "/errors?range=all&errorId=old&keep=1");
    draft("Search message, trace or name…", "timeout");
    draft("Environment…", "prod");
    draft("Exact trace ID…", "trace-1");
    draft("Exact user ID…", "user-1");
    draft("Exact session ID…", "session-1");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(useErrorsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: undefined,
        search: "timeout",
        environment: "prod",
        traceId: "trace-1",
        userId: "user-1",
        sessionId: "session-1",
      }),
    );
    expect(params().has("errorId")).toBe(false);
    draft("Exact user ID…", "unsubmitted");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(Object.fromEntries(params())).toEqual({ range: "all", keep: "1" });
    expect((screen.getByPlaceholderText("Exact user ID…") as HTMLInputElement).value).toBe("");
  });

  it("uses dashboard API from/to boundaries instead of the preset; presets clear custom dates", () => {
    mount(
      <DashboardPage />,
      "/?from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z&keep=1",
    );
    expect(useDashboardQuery).toHaveBeenLastCalledWith({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
    fireEvent.change(screen.getByLabelText("Dashboard start date"), { target: { value: "" } });
    expect(useDashboardQuery).toHaveBeenLastCalledWith({
      from: undefined,
      to: "2026-02-01T00:00:00.000Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(useDashboardQuery).toHaveBeenLastCalledWith({});
    expect(Object.fromEntries(params())).toEqual({ range: "all", keep: "1" });
  });
});
