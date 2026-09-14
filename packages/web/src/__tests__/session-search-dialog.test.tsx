// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSearchDialog } from "@/features/sessions/session-search-dialog";
import { getSessionSearchContext, searchSessions } from "@/shared/lib/api";
import type {
  SessionContextMessage,
  SessionSearchContext,
  SessionSearchHit,
  SessionSearchResponse,
} from "@/shared/lib/types";

vi.mock("@/shared/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  getSessionSearchContext: vi.fn(),
  searchSessions: vi.fn(),
}));

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

function message(overrides: Partial<SessionContextMessage> = {}): SessionContextMessage {
  const value = {
    role: "user",
    text: "refund failed",
    field: "input",
    messageOrder: 1,
    occurrenceId: "occ-1",
    truncated: false,
    highlight: [],
    blocks: [{ text: "refund failed", chunkNo: 0, truncated: false, highlight: [] }],
    blockCursor: null,
    blockBeforeCursor: null,
    ...overrides,
  } as SessionContextMessage;
  return {
    ...value,
    blocks: overrides.blocks ?? [{ text: value.text, chunkNo: 0, truncated: false, highlight: [] }],
  };
}

function preview(messages: SessionContextMessage[] = [message()]): SessionSearchContext {
  return {
    data: { sessionId: "session-1", occurrenceId: "occ-1", messages },
    meta: {
      contextScope: "source",
      truncated: true,
      beforeCursor: "before-cursor",
      afterCursor: "after-cursor",
      sourceVersion: 3,
    },
  };
}

function renderDialog(props: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  return render(
    <MemoryRouter>
      <SessionSearchDialog open={props.open ?? true} onOpenChange={props.onOpenChange ?? vi.fn()} />
    </MemoryRouter>,
  );
}

async function searchFor(query = "refund") {
  search.mockResolvedValueOnce(result());
  fireEvent.change(screen.getByLabelText("Search message text"), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
  await screen.findByRole("button", { name: /refund failed/ });
}

describe("SessionSearchDialog interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("opens with a one-hour range and does not prefetch search or context", () => {
    renderDialog();
    expect((screen.getByRole("combobox", { name: "Time range" }) as HTMLSelectElement).value).toBe(
      "3600",
    );
    expect(search).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
  });

  it("cancels an in-flight search without allowing its result to render", async () => {
    renderDialog();
    let resolveSearch!: (value: SessionSearchResponse) => void;
    search.mockImplementationOnce(
      (_query, _range, signal) =>
        new Promise((resolve) => {
          resolveSearch = resolve;
          signal?.addEventListener("abort", () => undefined);
        }),
    );
    fireEvent.change(screen.getByLabelText("Search message text"), { target: { value: "refund" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(search.mock.calls[0][2]?.aborted).toBe(true);
    resolveSearch(result());
    await waitFor(() => expect(screen.queryByRole("button", { name: /refund failed/ })).toBeNull());
  });

  it("validates absolute ranges and sends the selected absolute DTO", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Search message text"), { target: { value: "refund" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Time range" }), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-14T11:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-14T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByText("Choose a valid start and end time.")).toBeTruthy();
    expect(search).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-14T12:00" } });
    search.mockResolvedValueOnce(result());
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    expect(search.mock.calls[0][1]).toEqual({
      kind: "absolute",
      fromTimestamp: "2026-09-14T03:00:00.000Z",
      toTimestamp: "2026-09-14T04:00:00.000Z",
    });
  });

  it("does not intercept native date, range, or result button keyboard events", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("combobox", { name: "Time range" }), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-14T09:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-14T10:00" } });
    await searchFor();
    const dateInput = screen.getByLabelText("From");
    const rangeSelect = screen.getByRole("combobox", { name: "Time range" });
    const hitButton = screen.getByRole("button", { name: /refund failed/ });

    for (const target of [dateInput, rangeSelect, hitButton]) {
      for (const key of ["ArrowUp", "ArrowDown"]) {
        const event = createEvent.keyDown(target, { key });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    fireEvent.keyDown(dateInput, { key: "Enter" });
    expect(search).toHaveBeenCalledOnce();
  });

  it("loads context only after selecting a hit and preserves distinct occurrence anchors", async () => {
    const second = hit({ occurrenceId: "occ-2", messageOrder: 3, snippet: "refund pending" });
    renderDialog();
    search.mockResolvedValueOnce(result([hit(), second]));
    fireEvent.change(screen.getByLabelText("Search message text"), { target: { value: "refund" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("button", { name: /refund pending/ });
    expect(context).not.toHaveBeenCalled();
    context.mockResolvedValueOnce(preview());
    fireEvent.click(screen.getByRole("button", { name: /refund pending/ }));
    await waitFor(() => expect(context).toHaveBeenCalledOnce());
    expect(context.mock.calls[0][0]).toBe("occ-2");
    expect(context.mock.calls[0][1]).toBe(3);
    expect(context.mock.calls[0][3]).toEqual({ query: "refund" });
  });

  it("requests both cursor directions and merges returned messages", async () => {
    renderDialog();
    await searchFor();
    context.mockResolvedValueOnce(preview());
    fireEvent.click(screen.getByRole("button", { name: /refund failed/ }));
    await waitFor(() => expect(context).toHaveBeenCalledOnce());
    context.mockResolvedValueOnce(
      preview([message({ occurrenceId: "before", messageOrder: 0, text: "hello" })]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("hello");
    expect(context.mock.calls[1][3]).toEqual({
      direction: "before",
      cursor: "before-cursor",
      query: "refund",
    });
    context.mockResolvedValueOnce(
      preview([message({ occurrenceId: "after", messageOrder: 2, text: "goodbye" })]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByText("goodbye");
    expect(context.mock.calls[2][3]).toEqual({
      direction: "after",
      cursor: "after-cursor",
      query: "refund",
    });
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("goodbye")).toBeTruthy();
  });

  it("sends a message blockCursor when expanding a long message", async () => {
    renderDialog();
    await searchFor();
    context.mockResolvedValueOnce(
      preview([message({ text: "first block", truncated: true, blockCursor: "block-cursor" })]),
    );
    fireEvent.click(screen.getByRole("button", { name: /refund failed/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Context preview").textContent).toContain("first block"),
    );
    context.mockResolvedValueOnce(
      preview([
        message({
          text: "second block",
          blocks: [{ text: "second block", chunkNo: 1, truncated: false, highlight: [] }],
          blockCursor: null,
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load later text" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Context preview").textContent).toContain("second block"),
    );
    expect(context.mock.calls[1][3]).toEqual({ blockCursor: "block-cursor", query: "refund" });
  });

  it("loads earlier blocks with blockBeforeCursor and prepends them", async () => {
    renderDialog();
    await searchFor();
    context.mockResolvedValueOnce(
      preview([message({ text: "tail", truncated: true, blockBeforeCursor: "block-before" })]),
    );
    fireEvent.click(screen.getByRole("button", { name: /refund failed/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Context preview").textContent).toContain("tail"),
    );
    context.mockResolvedValueOnce(
      preview([
        message({
          text: "head",
          blocks: [{ text: "head", chunkNo: -1, truncated: false, highlight: [] }],
          blockBeforeCursor: null,
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load earlier text" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Context preview").textContent).toContain("head"),
    );
    expect(context.mock.calls[1][3]).toEqual({
      blockBeforeCursor: "block-before",
      query: "refund",
    });
  });

  it("shows every returned block initially and keeps the opposite block cursor", async () => {
    renderDialog();
    await searchFor();
    context.mockResolvedValueOnce(
      preview([
        message({
          blocks: [
            { text: "first", chunkNo: 0, truncated: false, highlight: [] },
            { text: "second", chunkNo: 1, truncated: false, highlight: [] },
            { text: "third matching block", chunkNo: 2, truncated: false, highlight: [] },
          ],
          blockBeforeCursor: "before-block",
          blockCursor: "after-block",
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: /refund failed/ }));
    await screen.findByText("third matching block");
    expect(screen.queryByRole("button", { name: "Expand message" })).toBeNull();

    context.mockResolvedValueOnce(
      preview([
        message({
          blocks: [{ text: "earlier", chunkNo: -1, truncated: false, highlight: [] }],
          blockBeforeCursor: null,
          blockCursor: null,
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load earlier text" }));
    await screen.findByText("earlier");
    expect(context.mock.calls[1][3]).toEqual({
      blockBeforeCursor: "before-block",
      query: "refund",
    });

    context.mockResolvedValueOnce(preview());
    fireEvent.click(screen.getByRole("button", { name: "Load later text" }));
    await waitFor(() => expect(context).toHaveBeenCalledTimes(3));
    expect(context.mock.calls[2][3]).toEqual({ blockCursor: "after-block", query: "refund" });
  });

  it("aborts stale requests when switching hits and closing the dialog", async () => {
    const first = hit();
    const second = hit({ occurrenceId: "occ-2", snippet: "refund pending" });
    const onOpenChange = vi.fn();
    const view = renderDialog({ onOpenChange });
    search.mockResolvedValueOnce(result([first, second]));
    fireEvent.change(screen.getByLabelText("Search message text"), { target: { value: "refund" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("button", { name: /refund pending/ });
    let resolveFirst!: (value: SessionSearchContext) => void;
    context.mockImplementationOnce(
      (_id, _version, signal) =>
        new Promise((resolve) => {
          resolveFirst = resolve;
          signal?.addEventListener("abort", () => undefined);
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: /refund failed/ }));
    context.mockResolvedValueOnce(preview([message({ text: "second context" })]));
    fireEvent.click(screen.getByRole("button", { name: /refund pending/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Context preview").textContent).toContain("second context"),
    );
    expect(context.mock.calls[0][2]?.aborted).toBe(true);
    resolveFirst(preview([message({ text: "stale context" })]));
    expect(screen.queryByText("stale context")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    view.rerender(
      <MemoryRouter>
        <SessionSearchDialog open={false} onOpenChange={onOpenChange} />
      </MemoryRouter>,
    );
  });
});
