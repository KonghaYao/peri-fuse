import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@peri/ui", async () => import("@/test/peri-ui-stub"));

import { waitFor } from "@solidjs/testing-library";
import { TracesPage } from "@/pages/traces-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

describe("TracesPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders trace rows from core + metrics queries", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, "");
      if (url.startsWith("/api/public/traces/metrics")) {
        return jsonResponse([
          {
            id: "trace-1",
            latency: 1.2,
            observationCount: 2,
            level: "DEFAULT",
            errorCount: 0,
            warningCount: 0,
            debugCount: 0,
            defaultCount: 2,
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
            cachedTokens: 0,
            cacheHitRate: 0,
            input: { messages: [{ role: "user", content: "hello" }] },
            output: { text: "hi there" },
            metadata: { source: "test" },
            calculatedInputCost: null,
            calculatedOutputCost: null,
            calculatedTotalCost: null,
            usageDetails: {},
            costDetails: {},
          },
        ]);
      }
      if (url.startsWith("/api/public/traces")) {
        return jsonResponse({
          data: [
            {
              id: "trace-1",
              timestamp: "2026-01-01T00:00:00.000Z",
              name: "chat",
              userId: "user-a",
              sessionId: "sess-1",
              release: null,
              version: null,
              environment: "prod",
              tags: [],
            },
          ],
          meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderWithProviders(() => <TracesPage />);

    await waitFor(() => {
      expect(view.container.querySelector("[data-trace-rows='1']")).toBeTruthy();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/public/traces/metrics"),
        expect.anything(),
      );
    });

    await waitFor(() => {
      const latencyCell = view.container.querySelector('[data-column="latency"]');
      expect(latencyCell?.textContent).toMatch(/1\.2/);
      expect(view.container.querySelector('[data-column="tokens"]')?.textContent).toBe("usage");
      expect(view.container.querySelector('[data-column="levelCounts"]')?.textContent).toBe(
        "levels",
      );
      expect(view.container.querySelector('[data-column="input"]')?.textContent).toBe("io");
      expect(view.container.querySelector(".ui-skeleton")).toBeNull();
    });
  });

  it("refetches traces when page changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const raw = String(input).replace(/^https?:\/\/[^/]+/, "");
      const page = new URL(raw, "http://localhost").searchParams.get("page") ?? "1";
      if (raw.startsWith("/api/public/traces/metrics")) {
        return jsonResponse([]);
      }
      if (raw.startsWith("/api/public/traces")) {
        return jsonResponse({
          data: [
            {
              id: `trace-page-${page}`,
              timestamp: "2026-01-01T00:00:00.000Z",
              name: "chat",
              userId: "user-a",
              sessionId: "sess-1",
              release: null,
              version: null,
              environment: "prod",
              tags: [],
            },
          ],
          meta: { page: Number(page), limit: 50, totalItems: 100, totalPages: 2 },
        });
      }
      return jsonResponse({ message: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderWithProviders(() => <TracesPage />);

    await waitFor(() => {
      expect(view.getByText("trace-page-1")).toBeTruthy();
    });

    view.getByTestId("table-next-page").click();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/[?&]page=2(?:&|$)/),
        expect.anything(),
      );
    });

    await waitFor(() => {
      expect(view.getByText("trace-page-2")).toBeTruthy();
    });
  });
});
