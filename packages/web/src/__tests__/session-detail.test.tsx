import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solidjs/router")>();
  return {
    ...actual,
    useParams: () => ({ sessionId: "sess-1" }),
    useSearchParams: () => [
      {
        page: undefined,
        traceId: "trace-1",
        observationId: "obs-1",
      },
      vi.fn(),
    ],
  };
});

vi.mock("@peri/ui", async () => {
  const stub = await import("@/test/peri-ui-stub");
  return {
    ...stub,
    MonitorTraceTurnTree: () => <div data-testid="session-tree" />,
  };
});

import { waitFor } from "@solidjs/testing-library";
import { SessionDetailPage } from "@/pages/session-detail-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

describe("SessionDetailPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders session header and trace rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/v2/observations")) {
          return jsonResponse({ data: [], meta: { cursor: null } });
        }
        if (url.startsWith("/api/public/sessions/sess-1")) {
          return jsonResponse({
            id: "sess-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            users: ["user-a"],
            countTraces: 1,
            totalCost: 0,
            totalTokens: 30,
            sessionDuration: 12,
            environment: "prod",
            meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
            traces: [
              {
                id: "trace-1",
                name: "turn-1",
                timestamp: "2026-01-01T00:00:00.000Z",
                userId: "user-a",
                input: null,
                output: null,
                latency: 1,
                totalCost: 0,
                promptTokens: 10,
                completionTokens: 20,
                totalTokens: 30,
                cachedTokens: 0,
                cacheHitRate: 0,
                scores: [],
                observations: [],
              },
            ],
          });
        }
        if (url.startsWith("/api/public/v2/observations")) {
          return jsonResponse({ data: [], meta: { cursor: null } });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <SessionDetailPage />);

    await waitFor(() => {
      expect(view.getByText("sess-1")).toBeTruthy();
      expect(view.getByText("turn-1")).toBeTruthy();
    });
  });
});
