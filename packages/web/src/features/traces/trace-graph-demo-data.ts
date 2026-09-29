import type { Observation } from "@/shared/lib/types";

const EPOCH = Date.parse("2026-09-29T09:00:00.000Z");

function observation(
  id: string,
  type: Observation["type"],
  name: string,
  parentObservationId: string | null,
  start: number,
  end: number,
  details: Partial<Observation> = {},
): Observation {
  return {
    id,
    type,
    name,
    traceId: "demo-agent-research",
    parentObservationId,
    startTime: new Date(EPOCH + start * 1_000).toISOString(),
    endTime: new Date(EPOCH + end * 1_000).toISOString(),
    level: "DEFAULT",
    statusMessage: null,
    version: null,
    model: type === "GENERATION" ? "demo-model" : null,
    promptTokens: type === "GENERATION" ? 320 : 0,
    completionTokens: type === "GENERATION" ? 85 : 0,
    totalTokens: type === "GENERATION" ? 405 : 0,
    ...details,
  };
}

/** Local fixture only: hidden wrappers, nested sync agents, and concurrent background work. */
export const TRACE_GRAPH_DEMO_OBSERVATIONS: Observation[] = [
  observation("root", "SPAN", "request lifecycle", null, 0, 30),
  observation("plan", "GENERATION", "Plan the research", "root", 0.1, 0.9, {
    input: [{ role: "user", content: "Research SQLite observability and prepare a short report." }],
    output: {
      role: "assistant",
      content:
        "I will inspect the workspace, delegate research, then draft the report while a background agent prepares references.",
    },
  }),
  observation("read", "TOOL", "Read workspace", "root", 1, 1.8, {
    input: { path: "README.md" },
    output: "Peri-Fuse: self-contained LLM observability, built on SQLite.",
  }),
  observation("research", "AGENT", "subagent:research", "root", 2, 14, {
    input: { task: "Gather and validate the architecture facts." },
    output: "Verified SQLite storage, trace ingestion, and project isolation.",
  }),
  observation("research-wrapper", "SPAN", "research workflow", "research", 2.1, 13.5),
  observation(
    "research-plan",
    "GENERATION",
    "Find the relevant sources",
    "research-wrapper",
    2.2,
    3.8,
    {
      input: [{ role: "user", content: "Identify the key architecture facts to verify." }],
      output: "Check the storage adapter, ingestion routes, and authentication boundaries.",
    },
  ),
  observation("fetch-error", "TOOL", "Fetch source · timeout", "research-wrapper", 4, 4.8, {
    level: "ERROR",
    statusMessage: "Source request timed out; retry succeeded.",
    input: { source: "architecture-notes", timeoutMs: 800 },
    output: { error: "Request timed out" },
  }),
  observation("fetch-retry", "TOOL", "Retry source fetch", "research-wrapper", 5, 6, {
    input: { source: "architecture-notes", attempt: 2 },
    output: "Storage uses SQLite; no separately deployed infrastructure is required.",
  }),
  observation("read-schema", "TOOL", "Read telemetry schema", "research-wrapper", 6.05, 6.2, {
    input: { path: "packages/shared/prisma/schema.sqlite.prisma" },
    output: "Observations retain their parent relationship and project identity.",
  }),
  observation("list-routes", "TOOL", "List ingestion routes", "research-wrapper", 6.25, 6.4, {
    input: { path: "packages/server/src/routes" },
    output: ["ingestion", "otel", "traces", "observations"],
  }),
  observation("verify", "AGENT", "subagent:verify", "research-wrapper", 6.5, 10.5, {
    input: { task: "Cross-check project isolation." },
    output: "Gateway queries are scoped to projectId.",
  }),
  observation("verify-gen", "GENERATION", "Check the isolation boundary", "verify", 7, 8, {
    input: [{ role: "user", content: "Verify project-scoped gateway access." }],
    output: "Inspect the authentication middleware and query filters.",
  }),
  observation("verify-tool", "TOOL", "Read auth middleware", "verify", 8.5, 9.8, {
    input: { path: "packages/gateway/src/middleware/auth.ts" },
    output: "Bearer and Basic keys resolve to one project; each request carries projectId.",
  }),
  observation(
    "research-summary",
    "GENERATION",
    "Return verified findings",
    "research-wrapper",
    11,
    13,
    {
      input: [{ role: "user", content: "Summarize the verified architecture facts." }],
      output:
        "SQLite stores telemetry locally. Project API keys isolate gateway resources. The trace API is compatible with Langfuse SDKs.",
    },
  ),
  observation("draft", "GENERATION", "Draft the report", "root", 14.2, 16, {
    input: [{ role: "user", content: "Use the research findings to draft a concise report." }],
    output:
      "Peri-Fuse provides local LLM observability and a project-scoped proxy gateway, with SQLite as its only storage dependency.",
  }),
  observation("background", "AGENT", "subagent:background", "root", 16.5, 28, {
    metadata: { run_in_background: true },
    input: { task: "Prepare a reference appendix.", run_in_background: true },
    output: "Reference appendix prepared independently.",
  }),
  observation("background-gen", "GENERATION", "Collect references", "background", 17, 18, {
    input: [
      { role: "user", content: "Prepare references while the main agent finalizes the report." },
    ],
    output: "Collect source paths and a brief description of each architecture boundary.",
  }),
  observation("main-wrapper", "SPAN", "finalization wrapper", "root", 18.2, 25),
  observation("write-report", "TOOL", "Write report.md", "main-wrapper", 18.5, 19.5, {
    input: {
      path: "report.md",
      content: "# SQLite observability\n\nLocal storage, compatible APIs, and project isolation.",
    },
    output: { written: true },
  }),
  observation("background-tool", "TOOL", "Read reference index", "background", 20, 21, {
    input: { path: "docs/index.md" },
    output: ["Storage adapters", "Ingestion pipeline", "Project-scoped authentication"],
  }),
  observation("final", "GENERATION", "Deliver the report", "main-wrapper", 21.5, 23, {
    input: [{ role: "user", content: "Present the final report." }],
    output:
      "The report is ready in report.md. The reference appendix is still running in the background.",
  }),
  observation("background-final", "GENERATION", "Finish the appendix", "background", 24, 27, {
    input: [{ role: "user", content: "Complete the reference appendix." }],
    output:
      "References are ready: storage adapters, trace ingestion, and gateway project isolation.",
  }),
];
