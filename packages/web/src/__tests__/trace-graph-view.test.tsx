// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACE_GRAPH_DEMO_OBSERVATIONS } from "@/features/traces/trace-graph-demo-data";
import { TracePeekView } from "@/features/traces/trace-peek-view";
import { ObservationTraceGraph } from "@/shared/components/observation-trace-graph";
import { ObservationTraceGraphDialog } from "@/shared/components/observation-trace-graph-dialog";
import { ObservationTraceGraphView } from "@/shared/components/observation-trace-graph-view";
import {
  getObservationDetail,
  getTraceIo,
  getTraceShell,
  listTraceObservationSummaries,
} from "@/shared/lib/api";
import type { Observation, TraceWithDetails } from "@/shared/lib/types";

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  listTraceObservationSummaries: vi.fn(),
  getObservationDetail: vi.fn(),
  getTraceIo: vi.fn(),
  getTraceShell: vi.fn(),
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
    vi.mocked(getTraceShell).mockResolvedValue(trace);
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

  it("removes the redundant graph launcher from the trace preview while retaining other actions", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TracePeekView traceId={trace.id} onClose={onClose} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: trace.name ?? "" });
    expect(screen.queryByRole("button", { name: "Trace graph" })).toBeNull();
    expect(screen.getByRole("button", { name: "Timeline" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full view" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    client.clear();
  });

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

  it("removes the graph title, legend and statistics without losing trace details or layout controls", async () => {
    const { client } = renderGraph();
    await screen.findByRole("button", { name: /GEN.*Plan the research/ });
    expect(screen.queryByText("Trace graph")).toBeNull();
    expect(screen.queryByText("BG launch")).toBeNull();
    expect(screen.queryByText(/points ·/)).toBeNull();
    expect(screen.getByRole("button", { name: "Trace details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show individual rows" }));
    expect(screen.getByRole("button", { name: "Group consecutive tools" })).toBeTruthy();
    client.clear();
  });

  it("puts tool counts beside TOOL and wraps every selectable tool without a horizontal scroller", () => {
    const tool = observations.find((observation) => observation.type === "TOOL");
    if (!tool) throw new Error("Tool fixture missing");
    const tools: Observation[] = Array.from({ length: 12 }, (_, index) => ({
      ...tool,
      id: `tool-${index}`,
      name: `Very long tool name ${index} ${"detail ".repeat(30)}`,
      parentObservationId: null,
      startTime: new Date(Date.parse(tool.startTime) + index * 1000).toISOString(),
      endTime: new Date(Date.parse(tool.startTime) + index * 1000 + 5).toISOString(),
    }));
    const onSelect = vi.fn();
    const { container } = render(
      <ObservationTraceGraph observations={tools} onSelect={onSelect} />,
    );
    const group = container.querySelector<HTMLDivElement>("[data-tool-group]");
    if (!group) throw new Error("Tool group missing");
    expect(screen.getByText("TOOL ×12")).toBeTruthy();
    expect(screen.queryByText("×12")).toBeNull();
    expect(group.style.height).toBe("76px");
    expect(group.querySelector(".overflow-x-auto")).toBeNull();
    const cards = group.querySelectorAll<HTMLButtonElement>("button");
    expect(cards).toHaveLength(12);
    expect(cards[0].title).toContain(tools[0].name);
    fireEvent.click(cards[11]);
    expect(onSelect).toHaveBeenCalledWith("tool-11");
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("76");
    fireEvent.click(screen.getByRole("button", { name: "Show individual rows" }));
    expect(container.querySelector("[data-tool-group]")).toBeNull();
    expect(screen.getByRole("button", { name: "Group consecutive tools" })).toBeTruthy();
  });
});
