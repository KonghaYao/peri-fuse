import { ArrowLeft, GitBranch } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ObservationDetail } from "@/shared/components/observation-detail";
import { ObservationTraceGraph } from "@/shared/components/observation-trace-graph";
import { Badge } from "@/shared/components/ui/badge";
import { TRACE_GRAPH_DEMO_OBSERVATIONS } from "./trace-graph-demo-data";

/** A project-independent preview that keeps all observation selection local. */
export function TraceGraphDemoPage() {
  const [selectedId, setSelectedId] = useState("plan");
  const selected = TRACE_GRAPH_DEMO_OBSERVATIONS.find((item) => item.id === selectedId);
  const generations = TRACE_GRAPH_DEMO_OBSERVATIONS.filter((item) => item.type === "GENERATION");
  const tools = TRACE_GRAPH_DEMO_OBSERVATIONS.filter((item) => item.type === "TOOL");

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <header className="shrink-0 border-b border-border px-6 py-5">
        <Link
          to="/traces"
          className="mb-3 inline-flex items-center gap-1 text-xs text-fg-tertiary hover:text-fg-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to traces
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <GitBranch className="h-5 w-5 text-brand" />
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-fg-primary">Trace graph</h1>
          <Badge variant="secondary">Demo</Badge>
          <span className="ml-auto text-xs text-fg-tertiary">
            {generations.length} generations · {tools.length} tools · 3 branches
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-fg-secondary">
          Follow each agent step in time order. Select any generation or tool to inspect its input
          and output.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-fg-tertiary">
          <span className="inline-flex items-center gap-2">
            <span className="h-0 w-6 border-t-2 border-brand" />
            Sync subagent branches and rejoins
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-0 w-6 border-t-2 border-dashed border-fg-secondary" />
            Background subagent starts asynchronously
          </span>
          <span>Ordinary spans are hidden</span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-secondary">
              Execution history
            </h2>
            <span className="font-mono text-[11px] text-fg-tertiary">research → report</span>
          </div>
          <div className="min-h-[320px] flex-1 overflow-auto p-3">
            <ObservationTraceGraph
              observations={TRACE_GRAPH_DEMO_OBSERVATIONS}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col bg-surface-raised">
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-secondary">
              Observation detail
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {selected && <ObservationDetail key={selected.id} observation={selected} scores={[]} />}
          </div>
          <p className="border-t border-border px-5 py-3 text-[11px] text-fg-tertiary">
            Sample data · no project setup required
          </p>
        </section>
      </div>
    </div>
  );
}
