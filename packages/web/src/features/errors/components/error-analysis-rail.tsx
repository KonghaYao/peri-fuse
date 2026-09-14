import { Activity, Fingerprint, GitBranch, Radio } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { formatDateTime } from "@/shared/lib/format";
import type { ErrorAnalysis } from "@/shared/lib/types";

function Metric(props: { label: string; value: string }) {
  return (
    <div class="border-l-2 border-danger/70 pl-3">
      <div class="font-mono text-xl font-semibold tracking-tight text-fg-primary">
        {props.value}
      </div>
      <div class="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-fg-tertiary">
        {props.label}
      </div>
    </div>
  );
}

export const ErrorAnalysisRail: Component<{
  analysis: ErrorAnalysis;
  onSelectSignature: (signature: string) => void;
}> = (props) => {
  const maxDaily = () => Math.max(...props.analysis.daily.map((item) => item.count), 1);

  return (
    <div class="space-y-6 p-4">
      <section>
        <div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Radio class="h-3.5 w-3.5 text-danger" size={14} /> Incident window
        </div>
        <div class="grid grid-cols-3 gap-3 lg:grid-cols-1">
          <Metric label="Errors" value={props.analysis.summary.totalErrors.toLocaleString()} />
          <Metric
            label="Affected traces"
            value={props.analysis.summary.affectedTraces.toLocaleString()}
          />
          <Metric
            label="Signatures"
            value={props.analysis.summary.uniqueSignatures.toLocaleString()}
          />
        </div>
        <Show when={props.analysis.summary.lastSeen}>
          <p class="mt-3 text-xs text-fg-tertiary">
            Last seen {formatDateTime(props.analysis.summary.lastSeen)}
          </p>
        </Show>
      </section>

      <section>
        <div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Activity class="h-3.5 w-3.5" size={14} /> Error pulse
        </div>
        <Show
          when={props.analysis.daily.length > 0}
          fallback={<p class="text-xs text-fg-tertiary">No errors in this window.</p>}
        >
          <div class="flex h-16 items-end gap-1 border-b border-line pb-1">
            <For each={props.analysis.daily}>
              {(item) => (
                <div
                  class="min-w-1 flex-1 rounded-t-sm bg-danger/70 transition-colors hover:bg-danger"
                  style={{ height: `${Math.max((item.count / maxDaily()) * 100, 8)}%` }}
                  title={`${item.date}: ${item.count} errors`}
                />
              )}
            </For>
          </div>
        </Show>
      </section>

      <section>
        <div class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Fingerprint class="h-3.5 w-3.5" size={14} /> Error fingerprints
        </div>
        <div class="space-y-1.5">
          <For each={props.analysis.groups}>
            {(group) => (
              <button
                type="button"
                onClick={() => props.onSelectSignature(group.signature)}
                class="group w-full rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-danger/20 hover:bg-danger-subtle focus-visible:border-danger"
              >
                <div class="line-clamp-2 font-mono text-[11px] leading-4 text-fg-primary">
                  {group.signature}
                </div>
                <div class="mt-1 flex items-center gap-2 text-[10px] text-fg-tertiary">
                  <span class="font-semibold text-danger">{group.count} hits</span>
                  <span>·</span>
                  <span>{group.traceCount} traces</span>
                </div>
              </button>
            )}
          </For>
        </div>
      </section>

      <Show when={props.analysis.models.length > 0}>
        <section>
          <div class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
            <GitBranch class="h-3.5 w-3.5" size={14} /> Models involved
          </div>
          <div class="flex flex-wrap gap-1.5">
            <For each={props.analysis.models}>
              {(item) => (
                <span class="rounded border border-line bg-surface-inset px-2 py-1 font-mono text-[10px] text-fg-secondary">
                  {item.model} · {item.count}
                </span>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
};
