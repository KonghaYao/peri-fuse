import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@peri/ui", async () => {
  const stub = await import("@/test/peri-ui-stub");
  return {
    ...stub,
    EnhancedDataTable: (props: { data?: unknown[] }) => (
      <div data-session-rows={props.data?.length ?? 0} />
    ),
  };
});

import { waitFor } from "@solidjs/testing-library";
import { SessionsPage } from "@/pages/sessions-page";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse, renderWithProviders } from "@/test/query-test-helpers";

const activeContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-active",
  secretKey: "sk-active",
};

describe("SessionsPage", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext(activeContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders session rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, "");
        if (url.startsWith("/api/public/sessions")) {
          return jsonResponse({
            data: [
              {
                id: "sess-1",
                createdAt: "2026-01-01T00:00:00.000Z",
                countTraces: 2,
                sessionDuration: 12,
                userIds: ["user-a"],
                traceTags: [],
                environment: "prod",
                promptTokens: 10,
                completionTokens: 20,
                totalTokens: 30,
                cachedTokens: 0,
              },
            ],
            meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
          });
        }
        return jsonResponse({ message: "not found" }, { status: 404 });
      }),
    );

    const view = renderWithProviders(() => <SessionsPage />);

    await waitFor(() => {
      expect(view.container.querySelector("[data-session-rows='1']")).toBeTruthy();
    });
  });
});
