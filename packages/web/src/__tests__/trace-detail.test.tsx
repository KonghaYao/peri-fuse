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

  it("shows observation detail in split pane when a node is selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/v2/observations") && url.includes("filter=")) {
          return jsonResponse({
            data: [
              {
                id: "obs-step-1",
                traceId: "trace-1",
                type: "SPAN",
                name: "step-1",
                startTime: "2026-01-01T00:00:00.000Z",
                endTime: "2026-01-01T00:00:06.970Z",
                level: "DEFAULT",
                input: { prompt: "hello" },
                output: { text: "world" },
                metadata: { stage: 1 },
              },
            ],
            meta: { cursor: null },
          });
        }
        if (url.startsWith("/api/public/v2/observations")) {
          return jsonResponse({
            data: [
              {
                id: "obs-step-1",
                traceId: "trace-1",
                type: "SPAN",
                name: "step-1",
                startTime: "2026-01-01T00:00:00.000Z",
                endTime: "2026-01-01T00:00:06.970Z",
                level: "DEFAULT",
                parentObservationId: null,
              },
            ],
            meta: { cursor: null },
          });
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
            observationCount: 1,
            scores: [],
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <TraceDetailPage />);

    await waitFor(() => {
      expect(view.getByTestId("monitor-trace-turn-node-obs-step-1")).toBeTruthy();
    });

    view.getByTestId("monitor-trace-turn-node-obs-step-1").click();

    await waitFor(() => {
      expect(view.getByTestId("detail-pane")).toBeTruthy();
      expect(view.getByTestId("detail-pane").textContent).toContain("step-1");
      expect(view.getByTestId("io-tab-input").textContent).toContain("hello");
      expect(view.getByTestId("io-tab-output").textContent).toContain("world");
      expect(view.getByTestId("io-tab-metadata").textContent).toContain("stage");
    });
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
      expect(view.getByRole("heading", { name: "chat" })).toBeTruthy();
      expect(view.getByTestId("trace-workspace")).toBeTruthy();
    });
  });
});
