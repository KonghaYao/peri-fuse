import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solidjs/router")>();
  return {
    ...actual,
    useParams: () => ({ traceId: "trace-1" }),
  };
});

vi.mock("@peri/ui", async () => import("@/test/peri-ui-stub"));

import { waitFor } from "@solidjs/testing-library";
import { TraceDetailPage } from "@/pages/trace-detail-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

describe("TraceDetailPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads trace shell and renders observation workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/v2/observations")) {
          return jsonResponse({ data: [], meta: { cursor: null } });
        }
        if (url.startsWith("/api/public/traces/trace-1")) {
          return jsonResponse({
            id: "trace-1",
            timestamp: "2026-01-01T00:00:00.000Z",
            name: "chat",
            userId: null,
            sessionId: null,
            release: null,
            version: null,
            environment: "prod",
            tags: [],
            latency: 0.5,
            totalCost: 0,
            observations: [],
            observationCount: 0,
            scores: [],
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <TraceDetailPage />);

    await waitFor(() => {
      expect(view.getByText("chat")).toBeTruthy();
      expect(view.container.querySelector("[data-testid='trace-workspace']")).toBeTruthy();
    });
  });
});
