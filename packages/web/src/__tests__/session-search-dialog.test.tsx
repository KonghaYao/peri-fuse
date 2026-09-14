import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  getSessionSearchContext: vi.fn(),
  searchSessions: vi.fn(),
}));

vi.mock("@peri/ui", async () => {
  const stub = await import("@/test/peri-ui-stub");
  return {
    ...stub,
    Button: stub.Button,
    EmptyState: (props: { title: string }) => <div>{props.title}</div>,
    DialogDescription: stub.DialogDescription,
  };
});

import { fireEvent, waitFor } from "@solidjs/testing-library";
import { SessionSearchDialog } from "@/features/sessions/session-search-dialog";
import { getSessionSearchContext, searchSessions } from "@/shared/lib/api";
import type { SessionSearchHit, SessionSearchResponse } from "@/shared/lib/types";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { renderWithProviders } from "@/test/query-test-helpers";

const search = vi.mocked(searchSessions);
const context = vi.mocked(getSessionSearchContext);

function hit(overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    occurrenceId: "occ-1",
    sourceVersion: 3,
    sessionId: "session-1",
    sourceKind: "observation",
    sourceId: "obs-1",
    traceId: "trace-1",
    role: "user",
    field: "input",
    messageOrder: 1,
    recordTime: "2026-09-14T10:00:00.000Z",
    snippet: "refund failed",
    highlight: [{ start: 0, end: 6 }],
    sourceAnchor: {
      traceId: "trace-1",
      sourceKind: "observation",
      sourceId: "obs-1",
      field: "input",
      messageOrder: 1,
      chunkNo: 0,
    },
    ...overrides,
  };
}

function result(hits: SessionSearchHit[] = [hit()]): SessionSearchResponse {
  return {
    data: [{ sessionId: "session-1", hits }],
    meta: {
      returnedSessions: 1,
      limited: false,
      limitReason: null,
      indexState: "ready",
      coverage: "complete",
      resolvedTimeRange: {
        fromTimestamp: "2026-09-14T09:00:00.000Z",
        toTimestamp: "2026-09-14T10:00:00.000Z",
      },
    },
  };
}

describe("SessionSearchDialog", () => {
  beforeEach(() => {
    clearProjectContext();
    setProjectContext({
      projectId: "proj-1",
      projectName: "Alpha",
      publicKey: "pk",
      secretKey: "sk",
    });
    search.mockReset();
    context.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires at least 3 characters before searching", async () => {
    const view = renderWithProviders(() => (
      <SessionSearchDialog open={true} onOpenChange={() => undefined} />
    ));

    fireEvent.click(view.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(view.getByText("Search text must be 3–128 characters.")).toBeTruthy();
      expect(search).not.toHaveBeenCalled();
    });
  });

  it("searches and shows grouped hits", async () => {
    search.mockResolvedValue(result());

    const view = renderWithProviders(() => (
      <SessionSearchDialog open={true} onOpenChange={() => undefined} />
    ));

    fireEvent.input(view.getByLabelText("Search message text"), {
      target: { value: "refund" },
    });
    fireEvent.click(view.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(search).toHaveBeenCalled();
      expect(view.getByText("session-1")).toBeTruthy();
      expect(view.getByText(/refund/)).toBeTruthy();
    });
  });
});
