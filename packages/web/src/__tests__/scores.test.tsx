import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@peri/ui", async () => import("@/test/peri-ui-stub"));

import { waitFor } from "@solidjs/testing-library";
import { ScoresPage } from "@/pages/scores-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

describe("ScoresPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists scores with numeric and string values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/v2/scores")) {
          return jsonResponse({
            data: [
              {
                id: "s1",
                name: "quality",
                value: 0.95,
                stringValue: null,
                dataType: "NUMERIC",
                source: "API",
                timestamp: "2026-01-01T00:00:00.000Z",
                traceId: "trace-abc123456789",
                comment: null,
              },
              {
                id: "s2",
                name: "label",
                value: null,
                stringValue: "good",
                dataType: "CATEGORICAL",
                source: "EVAL",
                timestamp: "2026-01-02T00:00:00.000Z",
                traceId: null,
                comment: "ok",
              },
            ],
            meta: { page: 1, limit: 25, totalItems: 2, totalPages: 1 },
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <ScoresPage />);

    await waitFor(() => {
      expect(view.getByText("quality")).toBeTruthy();
      expect(view.getByText("good")).toBeTruthy();
      expect(view.getByText("Unlinked")).toBeTruthy();
    });
  });
});
