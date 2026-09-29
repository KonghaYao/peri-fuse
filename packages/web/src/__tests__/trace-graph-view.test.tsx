// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACE_GRAPH_DEMO_OBSERVATIONS } from "@/features/traces/trace-graph-demo-data";
import { ObservationTraceGraphDialog } from "@/shared/components/observation-trace-graph-dialog";
import { ObservationTraceGraphView } from "@/shared/components/observation-trace-graph-view";
import { getObservationDetail, getTraceIo, listTraceObservationSummaries } from "@/shared/lib/api";
import type { TraceWithDetails } from "@/shared/lib/types";

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  listTraceObservationSummaries: vi.fn(),
  getObservationDetail: vi.fn(),
  getTraceIo: vi.fn(),
}));

const observations = TRACE_GRAPH_DEMO_OBSERVATIONS.filter((o) => ["plan", "read"].includes(o.id));
const trace: TraceWithDetails = {
  id: "trace-1",
  name: "Parallel trace",
  timestamp: "2026-09-29T09:00:00.000Z",
  userId: null,
  sessionId: null,
  release: null,
  version: null,
  tags: [],
  latency: 2,
  totalCost: 0,
  observationCount: 2,
  observations,
  scores: [],
};

function renderGraph(fullscreen = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const onOpenChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      {fullscreen ? (
        <ObservationTraceGraphDialog trace={trace} open onOpenChange={onOpenChange} />
      ) : (
        <ObservationTraceGraphView trace={trace} />
      )}
    </QueryClientProvider>,
  );
  return { ...view, client, onOpenChange };
}

describe("trace graph floating details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTraceObservationSummaries).mockResolvedValue({
      data: observations,
      meta: { cursor: null },
    });
    vi.mocked(getObservationDetail).mockImplementation(async (id) => {
      const observation = observations.find((item) => item.id === id);
      if (!observation) throw new Error("Missing observation");
      return observation;
    });
    vi.mocked(getTraceIo).mockResolvedValue({
      ...trace,
      input: "Trace request",
      output: "Trace result",
    });
  });
  afterEach(() => cleanup());

  it("loads details on click, keeps the graph mounted, switches items, and closes with Escape", async () => {
    const { container, client } = renderGraph();
    const generation = await screen.findByRole("button", { name: /GEN.*Plan the research/ });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getObservationDetail).not.toHaveBeenCalled();
    expect(getTraceIo).not.toHaveBeenCalled();

    generation.focus();
    fireEvent.click(generation);
    await screen.findByRole("dialog", { name: "Plan the research" });
    expect(getObservationDetail).toHaveBeenCalledWith("plan");
    expect(container.contains(generation)).toBe(true);
    const tool = screen.getByRole("button", { name: /TOOL.*Read workspace/ });
    tool.focus();
    fireEvent.click(tool);
    await screen.findByRole("dialog", { name: "Read workspace" });
    expect(getObservationDetail).toHaveBeenCalledWith("read");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tool));
    client.clear();
  });

  it("keeps trace IO accessible and closes only the floating details inside the fullscreen graph", async () => {
    const { client, onOpenChange } = renderGraph(true);
    fireEvent.click(await screen.findByRole("button", { name: "Trace details" }));
    const details = await screen.findByRole("dialog", { name: "Trace details" });
    await waitFor(() => expect(getTraceIo).toHaveBeenCalledWith(trace.id));
    fireEvent.keyDown(details, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trace details" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Trace graph" })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    client.clear();
  });
});
