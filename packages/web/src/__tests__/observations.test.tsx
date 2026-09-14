import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@peri/ui", async () => import("@/test/peri-ui-stub"));

import { waitFor } from "@solidjs/testing-library";
import { ObservationsPage } from "@/pages/observations-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

describe("ObservationsPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders observation rows with trace links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/observations")) {
          return jsonResponse({
            data: [
              {
                id: "obs-1",
                name: "chat",
                type: "GENERATION",
                level: "DEFAULT",
                startTime: "2026-01-01T00:00:00.000Z",
                model: "gpt-4",
                totalTokens: 100,
                traceId: "trace-abcdef123456",
                statusMessage: null,
              },
            ],
            meta: { page: 1, limit: 25, totalItems: 1, totalPages: 1 },
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <ObservationsPage />);

    await waitFor(() => {
      expect(view.getByText("chat")).toBeTruthy();
      expect(view.getByText("GENERATION")).toBeTruthy();
    });
  });
});
