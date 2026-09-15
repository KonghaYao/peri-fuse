import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@peri/ui", async () => import("@/test/peri-ui-stub"));

import { waitFor } from "@solidjs/testing-library";
import { ErrorsPage } from "@/pages/errors-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

const emptyAnalysis = {
  summary: {
    totalErrors: 0,
    affectedTraces: 0,
    uniqueSignatures: 0,
    firstSeen: null,
    lastSeen: null,
  },
  groups: [],
  models: [],
  daily: [],
  data: [],
  meta: { cursor: null },
};

const sampleError = {
  id: "err-1",
  traceId: "trace-1",
  parentObservationId: null,
  name: "failed-generation",
  type: "GENERATION",
  startTime: "2026-01-01T00:00:00.000Z",
  endTime: "2026-01-01T00:00:01.000Z",
  statusMessage: "rate limit",
  model: "gpt-4",
  environment: "prod",
  traceName: "chat",
  sessionId: null,
  userId: null,
};

const sampleFingerprint = {
  signature: "rate-limit-exceeded",
  count: 3,
  traceCount: 2,
  lastSeen: "2026-01-01T00:00:00.000Z",
};

function mockErrorsFetch(
  handler: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    return handler(url);
  });
}

describe("ErrorsPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders left operations rail and error table", async () => {
    vi.stubGlobal(
      "fetch",
      mockErrorsFetch((url) => {
        if (url.startsWith("/api/public/errors")) {
          return jsonResponse({
            ...emptyAnalysis,
            summary: {
              totalErrors: 1,
              affectedTraces: 1,
              uniqueSignatures: 1,
              firstSeen: "2026-01-01T00:00:00.000Z",
              lastSeen: "2026-01-01T00:00:00.000Z",
            },
            groups: [sampleFingerprint],
            daily: [{ date: "2026-01-01", count: 1 }],
            data: [sampleError],
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <ErrorsPage />);

    await waitFor(() => {
      expect(view.getAllByText("Filters").length).toBeGreaterThan(0);
      expect(view.getAllByText("Incident window").length).toBeGreaterThan(0);
      expect(view.getAllByText("Error pulse").length).toBeGreaterThan(0);
      expect(view.getAllByText("Error fingerprints").length).toBeGreaterThan(0);
      expect(view.getByText("failed-generation")).toBeTruthy();
      expect(view.getByText("rate limit")).toBeTruthy();
      expect(view.getByText("1 matching errors")).toBeTruthy();
      expect(view.getAllByText("rate-limit-exceeded").length).toBeGreaterThan(0);
      expect(view.container.querySelector('[data-table-rows="1"]')).toBeTruthy();
    });
  });

  it("renders empty state when no errors match", async () => {
    vi.stubGlobal(
      "fetch",
      mockErrorsFetch((url) => {
        if (url.startsWith("/api/public/errors")) {
          return jsonResponse(emptyAnalysis);
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <ErrorsPage />);

    await waitFor(() => {
      expect(view.getByText("No errors match this investigation window.")).toBeTruthy();
      expect(view.getByText("0 matching errors")).toBeTruthy();
      expect(view.getAllByText("No errors in this window.").length).toBeGreaterThan(0);
      expect(view.getAllByText("No recurring signatures in this window.").length).toBeGreaterThan(0);
    });
  });

  it("renders error state with retry when the query fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockErrorsFetch(() => jsonResponse({ message: "server error" }, { status: 500 })),
    );

    const view = renderWithProviders(() => <ErrorsPage />);

    await waitFor(() => {
      expect(view.getByRole("alert")).toBeTruthy();
    });
  });

  it("opens investigation panel when a table row is selected", async () => {
    vi.stubGlobal(
      "fetch",
      mockErrorsFetch((url) => {
        if (url.startsWith("/api/public/errors")) {
          return jsonResponse({
            ...emptyAnalysis,
            summary: {
              totalErrors: 1,
              affectedTraces: 1,
              uniqueSignatures: 1,
              firstSeen: "2026-01-01T00:00:00.000Z",
              lastSeen: "2026-01-01T00:00:00.000Z",
            },
            data: [sampleError],
          });
        }
        if (url.startsWith("/api/public/v2/observations")) {
          return jsonResponse({
            data: [
              {
                id: "err-1",
                name: "failed-generation",
                type: "GENERATION",
                level: "ERROR",
                startTime: "2026-01-01T00:00:00.000Z",
                endTime: "2026-01-01T00:00:01.000Z",
                statusMessage: "rate limit",
                input: { prompt: "hello" },
                output: null,
                metadata: {},
                model: "gpt-4",
                traceId: "trace-1",
              },
            ],
            meta: { cursor: null },
          });
        }
        if (url.startsWith("/api/public/traces/trace-1")) {
          return jsonResponse({
            id: "trace-1",
            name: "chat",
            timestamp: "2026-01-01T00:00:00.000Z",
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <ErrorsPage />);

    await waitFor(() => {
      expect(view.container.querySelector('[data-row-key="err-1"]')).toBeTruthy();
    });

    view.container.querySelector('[data-row-key="err-1"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    await waitFor(() => {
      expect(view.getByText("Investigation path")).toBeTruthy();
      expect(view.getByLabelText("Close investigation")).toBeTruthy();
    });
  });

  it("filters by fingerprint signature when a fingerprint is clicked", async () => {
    const fetchMock = mockErrorsFetch((url) => {
      if (url.startsWith("/api/public/errors")) {
        return jsonResponse({
          ...emptyAnalysis,
          summary: {
            totalErrors: 3,
            affectedTraces: 2,
            uniqueSignatures: 1,
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-01T00:00:00.000Z",
          },
          groups: [sampleFingerprint],
          daily: [{ date: "2026-01-01", count: 3 }],
          data: [sampleError],
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderWithProviders(() => <ErrorsPage />);

    await waitFor(() => {
      expect(view.getAllByText("rate-limit-exceeded").length).toBeGreaterThan(0);
    });

    view.getAllByText("rate-limit-exceeded")[0]?.closest("button")?.click();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("search=rate-limit-exceeded"))).toBe(
        true,
      );
    });
  });
});
