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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
      }),
    );

    const view = renderWithProviders(() => <TracesPage />);

    await waitFor(() => {
      expect(view.container.querySelector("[data-trace-rows='1']")).toBeTruthy();
    });
  });
});
