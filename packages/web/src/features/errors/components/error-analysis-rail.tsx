import { Activity, Fingerprint, GitBranch, Radio } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { formatDateTime } from "@/shared/lib/format";
import type { ErrorAnalysis } from "@/shared/lib/types";

function Metric(props: { label: string; value: string }) {
  return (
    <div class="border-l-2 border-danger/70 pl-12">
      <div class="font-mono text-xl font-semibold tracking-tight text-fg-primary">
        {props.value}
      </div>
      <div class="mt-2 text-[10px] uppercase tracking-[0.08em] text-fg-tertiary">
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
    <div class="space-y-24 p-16">
      <section>
        <div class="mb-12 flex items-center gap-8 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Radio class="h-14 w-14 text-danger" size={14} /> Incident window
        </div>
        <div class="grid grid-cols-3 gap-12 lg:grid-cols-1">
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
          <p class="mt-12 text-xs text-fg-tertiary">
            Last seen {formatDateTime(props.analysis.summary.lastSeen)}
          </p>
        </Show>
      </section>

      <section>
        <div class="mb-12 flex items-center gap-8 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Activity class="h-14 w-14" size={14} /> Error pulse
        </div>
        <Show
          when={props.analysis.daily.length > 0}
          fallback={<p class="text-xs text-fg-tertiary">No errors in this window.</p>}
        >
          <div class="flex h-64 items-end gap-4 border-b border-line pb-4">
            <For each={props.analysis.daily}>
              {(item) => (
                <div
                  class="min-w-4 flex-1 rounded-t-sm bg-danger/70 transition-colors hover:bg-danger"
                  style={{ height: `${Math.max((item.count / maxDaily()) * 100, 8)}%` }}
                  title={`${item.date}: ${item.count} errors`}
                />
              )}
            </For>
          </div>
        </Show>
      </section>

      <section>
        <div class="mb-8 flex items-center gap-8 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Fingerprint class="h-14 w-14" size={14} /> Error fingerprints
        </div>
        <div class="space-y-6">
          <For each={props.analysis.groups}>
            {(group) => (
              <button
                type="button"
                onClick={() => props.onSelectSignature(group.signature)}
                class="group w-full rounded-md border border-transparent px-10 py-8 text-left transition-colors hover:border-danger/20 hover:bg-danger-subtle focus-visible:border-danger"
              >
                <div class="line-clamp-8 font-mono text-[11px] leading-4 text-fg-primary">
                  {group.signature}
                </div>
                <div class="mt-4 flex items-center gap-8 text-[10px] text-fg-tertiary">
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
          <div class="mb-8 flex items-center gap-8 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
            <GitBranch class="h-14 w-14" size={14} /> Models involved
          </div>
          <div class="flex flex-wrap gap-6">
            <For each={props.analysis.models}>
              {(item) => (
                <span class="rounded border border-line bg-surface-inset px-8 py-4 font-mono text-[10px] text-fg-secondary">
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
