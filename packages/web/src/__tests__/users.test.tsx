import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@peri/ui", async () => {
  const stub = await import("@/test/peri-ui-stub");
  return {
    ...stub,
    FilterInput: (props: {
      value?: string;
      onCommit?: (v: string | undefined) => void;
      placeholder?: string;
    }) => <input aria-label={props.placeholder} value={props.value ?? ""} readOnly />,
    PaginationControls: (props: { total?: number }) => (
      <div data-pagination-total={props.total ?? 0} />
    ),
    TableInlineError: (props: { error: unknown; onRetry?: () => void }) => (
      <div role="alert">
        <button type="button" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    ),
    EmptyState: (props: { title: string }) => <div data-empty>{props.title}</div>,
    AutoRefreshIntervalControl: () => <div data-auto-refresh />,
  };
});

import { waitFor } from "@solidjs/testing-library";
import { UsersPage } from "@/pages/users-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

function mockPublicFetch(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? `${input.pathname}${input.search}`
          : input.url;
    const url = raw.replace(/^https?:\/\/[^/]+/, "");
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) return handler();
    }
    return jsonResponse({ message: `Unhandled ${url}` }, { status: 404 });
  });
}

describe("UsersPage", () => {
  beforeEach(() => {
    clearProjectContext();
    localStorage.clear();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders users from the API", async () => {
    vi.stubGlobal(
      "fetch",
      mockPublicFetch({
        "/api/public/users": () =>
          jsonResponse({
            data: [
              {
                id: "user-1",
                firstSeen: "2026-01-01T00:00:00.000Z",
                lastSeen: "2026-01-02T00:00:00.000Z",
                countTraces: 3,
                countObservations: 9,
                totalTokens: 1200,
              },
            ],
            meta: { page: 1, limit: 25, totalItems: 1, totalPages: 1 },
          }),
      }),
    );

    const view = renderWithProviders(() => <UsersPage />);

    await waitFor(() => {
      expect(view.getByText("user-1")).toBeTruthy();
    });
  });

  it("shows empty state when no users match", async () => {
    vi.stubGlobal(
      "fetch",
      mockPublicFetch({
        "/api/public/users": () =>
          jsonResponse({
            data: [],
            meta: { page: 1, limit: 25, totalItems: 0, totalPages: 0 },
          }),
      }),
    );

    const view = renderWithProviders(() => <UsersPage />);

    await waitFor(() => {
      expect(view.getByText("No users found.")).toBeTruthy();
    });
  });
});
