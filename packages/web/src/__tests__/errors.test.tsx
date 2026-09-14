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

describe("ErrorsPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders error list from infinite query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/errors")) {
          return jsonResponse({
            summary: {
              totalErrors: 1,
              affectedTraces: 1,
              uniqueSignatures: 1,
              firstSeen: "2026-01-01T00:00:00.000Z",
              lastSeen: "2026-01-01T00:00:00.000Z",
            },
            groups: [],
            models: [],
            daily: [],
            data: [
              {
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
              },
            ],
            meta: { cursor: null },
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <ErrorsPage />);

    await waitFor(() => {
      expect(view.getByText("failed-generation")).toBeTruthy();
      expect(view.getByText("rate limit")).toBeTruthy();
    });
  });
});
