import { describe, expect, it } from "vitest";
import { buildTraceGraphDisplay } from "@/shared/components/observation-trace-graph-display-layout";
import {
  buildTraceGraph,
  type TraceGraphModel,
  type TraceGraphNode,
} from "@/shared/components/observation-trace-graph-layout";
import { getGenerationPreview } from "@/shared/lib/generation-preview";
import type { Observation } from "@/shared/lib/types";

function parallelAgents(nested = false): Observation[] {
  const observation = (
    id: string,
    type: string,
    parentObservationId: string | null,
    start: number,
  ): Observation => ({
    id,
    type,
    name: type === "AGENT" ? `subagent-${id}` : id,
    traceId: "parallel-agents",
    parentObservationId,
    startTime: new Date(start * 1000).toISOString(),
    endTime: new Date(10_000).toISOString(),
    level: "DEFAULT",
    statusMessage: null,
    version: null,
    model: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    metadata: { background: id === "b" },
  });
  return [
    observation("launch", "TOOL", null, 0),
    observation("a", "AGENT", "launch", 1),
    observation("b", "AGENT", "launch", 1.01),
    observation("c", "AGENT", nested ? "a" : "launch", 1.02),
    observation("gen-a", "GENERATION", "a", 2),
    observation("gen-b", "GENERATION", "b", 3),
    observation("gen-c", "GENERATION", "c", 4),
  ];
}

function model(kinds: TraceGraphNode["kind"][], lanes = kinds.map(() => 0)): TraceGraphModel {
  const nodes = kinds.map(
    (kind, index): TraceGraphNode => ({
      id: String(index),
      observation: null,
      kind,
      lane: lanes[index],
      branchId: `branch-${lanes[index]}`,
      timestamp: index,
      label: kind,
      background: false,
    }),
  );
  return {
    nodes,
    laneCount: 2,
    branchCount: 1,
    hiddenCount: 0,
    startTime: 0,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: { row: index, lane: lanes[index] },
      to: { row: index + 1, lane: node.lane },
      kind: "sequence",
      lane: node.lane,
      background: false,
    })),
  };
}

describe("trace graph compact layout", () => {
  it("groups consecutive tools and reconnects the following generation without losing nodes", () => {
    const input = model(["generation", "tool", "tool", "tool", "tool", "generation"]);
    const display = buildTraceGraphDisplay(input, true);
    expect(display.rows.map((row) => row.nodes.length)).toEqual([1, 4, 1]);
    expect(display.rows.flatMap((row) => row.nodes.map((node) => node.id))).toEqual(
      input.nodes.map((node) => node.id),
    );
    expect(display.edges.map((edge) => [edge.from.row, edge.to.row])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(display.rows[2].top).toBe(display.rows[0].height + display.rows[1].height);
    expect(buildTraceGraphDisplay(input, false).rows).toHaveLength(6);
  });

  it("keeps branch changes, generations and forks between groups", () => {
    const input = model(["tool", "tool", "fork", "tool", "generation", "tool"], [0, 1, 1, 1, 1, 1]);
    expect(buildTraceGraphDisplay(input, true).rows).toHaveLength(6);
  });

  it("retains a background fork when its source tools collapse to one row", () => {
    const input = model(["tool", "tool", "fork", "generation"], [0, 0, 1, 1]);
    input.edges[1] = { ...input.edges[1], kind: "fork", background: true };
    const fork = buildTraceGraphDisplay(input, true).edges.find((edge) => edge.kind === "fork");
    expect(fork).toMatchObject({
      from: { row: 0, lane: 0 },
      to: { row: 1, lane: 1 },
      background: true,
    });
  });

  it("launches sibling forks from one point while preserving each branch and its background mode", () => {
    const input = buildTraceGraph(parallelAgents());
    const display = buildTraceGraphDisplay(input, true);
    const forkRow = display.rows.findIndex((row) => row.nodes[0].kind === "fork");
    expect(display.rows[forkRow].nodes.map((node) => node.observation?.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(display.rows[forkRow].lane).toBe(0);
    const launches = display.edges.filter((edge) => edge.kind === "fork");
    expect(launches).toHaveLength(3);
    expect(launches.map((edge) => edge.from)).toEqual(Array(3).fill({ row: forkRow, lane: 0 }));
    expect(launches.map((edge) => edge.to.lane)).toEqual([1, 2, 3]);
    expect(launches.map((edge) => edge.background)).toEqual([false, true, false]);
    expect(
      display.edges.filter((edge) => edge.kind === "join").map((edge) => edge.from.lane),
    ).toEqual([1, 3]);
    expect(display.rows.flatMap((row) => row.nodes)).toEqual(input.nodes);
    expect(buildTraceGraphDisplay(input, false).rows.every((row) => row.nodes.length === 1)).toBe(
      true,
    );
  });

  it("keeps nested launches separate from sibling fork groups", () => {
    const display = buildTraceGraphDisplay(buildTraceGraph(parallelAgents(true)), true);
    const forks = display.rows.filter((row) => row.nodes[0].kind === "fork");
    expect(forks.map((row) => row.nodes.map((node) => node.observation?.id))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });
});

describe("generation output excerpts", () => {
  it.each([
    ["  Start here\nthen continue ", "Start here then continue"],
    [{ text: "Answer", thinking: "private reasoning" }, "Answer"],
    [{ role: "assistant", content: "Answer" }, "Answer"],
    [{ choices: [{ message: { role: "assistant", content: "Answer" } }] }, "Answer"],
    [
      {
        output: [
          { type: "reasoning", text: "ignore" },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Answer" }],
          },
        ],
      },
      "Answer",
    ],
    [
      [
        { role: "user", content: "ignore input" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "ignore" },
            { type: "text", text: "Answer" },
          ],
        },
      ],
      "Answer",
    ],
    [JSON.stringify({ content: [{ type: "text", text: "Answer" }] }), "Answer"],
    [{ content: [{ type: "tool_use", name: "Read", input: { path: "secret" } }] }, null],
    [{ thinking: "Not an answer", other: "No raw JSON preview" }, null],
  ])("extracts assistant text from %j", (output, expected) => {
    expect(getGenerationPreview(output)).toBe(expected);
  });

  it("truncates Unicode without splitting emoji", () => {
    expect(getGenerationPreview("你好🙂后面更多", 3)).toBe("你好🙂…");
  });
});
