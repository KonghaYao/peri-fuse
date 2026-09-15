import {
  Button,
  Chart,
  FilterInput,
  type FilterInputHandle,
  FilterSelect,
  Skeleton,
  StatChip,
  Statistic,
} from "@peri/ui";
import { Activity, Clock3, Fingerprint, Globe, GitBranch, Search, X } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { dayTick } from "@/features/dashboard/chart-utils";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { formatDateTime } from "@/shared/lib/format";
import type { ErrorAnalysis } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

const RANGE_MS_KEYS = ["24h", "7d", "30d", "all"] as const;

export const ErrorOperationsRail: Component<{
  analysis: ErrorAnalysis | undefined;
  range: string;
  search?: string;
  type?: string;
  model?: string;
  environment?: string;
  hasActiveFilters: boolean;
  isLoading: boolean;
  onRangeChange: (range: string) => void;
  onFilterChange: (key: string, value: string | undefined) => void;
  onSearchCommit: () => void;
  onClearFilters: () => void;
  onSelectSignature: (signature: string) => void;
  bindSearchRef: (handle: FilterInputHandle | undefined) => void;
  bindEnvironmentRef: (handle: FilterInputHandle | undefined) => void;
}> = (props) => {
  const labels = () => props.analysis?.daily.map((item) => item.date) ?? [];
  const values = () => props.analysis?.daily.map((item) => item.count) ?? [];
  const hasPulse = () => values().some((value) => value > 0);

  return (
    <div class="flex min-h-0 flex-col">
      <section class="shrink-0 space-y-10 border-b border-line p-16">
        <div class="flex items-center justify-between gap-8">
          <h2 class="text-12 font-semibold text-fg-primary">Filters</h2>
          <AutoRefreshControl />
        </div>

        <div class="flex rounded-md border border-line bg-surface-inset p-2">
          <For each={RANGE_MS_KEYS}>
            {(item) => (
              <button
                type="button"
                onClick={() => props.onRangeChange(item)}
                class={cn(
                  "flex-1 rounded px-8 py-4 text-11 font-medium transition-colors",
                  props.range === item
                    ? "bg-surface-raised text-fg-primary shadow-sm"
                    : "text-fg-tertiary hover:text-fg-primary",
                )}
              >
                {item === "all" ? "All" : item}
              </button>
            )}
          </For>
        </div>

        <FilterInput
          ref={props.bindSearchRef}
          placeholder="Search message, trace or name…"
          icon={Search}
          value={props.search}
          onCommit={(value) => props.onFilterChange("search", value)}
        />
        <FilterInput
          ref={props.bindEnvironmentRef}
          placeholder="Environment…"
          icon={Globe}
          value={props.environment}
          onCommit={(value) => props.onFilterChange("environment", value)}
        />
        <FilterSelect
          class="w-full"
          placeholder="Type"
          allLabel="All types"
          value={props.type}
          onCommit={(value) => props.onFilterChange("type", value)}
          options={["GENERATION", "SPAN", "EVENT", "AGENT", "TOOL"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <FilterSelect
          class="w-full"
          placeholder="Model"
          allLabel="All models"
          value={props.model}
          onCommit={(value) => props.onFilterChange("model", value)}
          options={(props.analysis?.models ?? []).map((item) => ({
            value: item.model,
            label: `${item.model} (${item.count})`,
          }))}
        />

        <div class="flex flex-wrap gap-8">
          <Button size="sm" variant="secondary" onClick={props.onSearchCommit}>
            <Search class="h-14 w-14" size={14} /> Search
          </Button>
          <Show when={props.hasActiveFilters}>
            <Button size="sm" variant="ghost" onClick={props.onClearFilters}>
              <X class="h-14 w-14" size={14} /> Clear
            </Button>
          </Show>
        </div>
      </section>

      <section class="shrink-0 space-y-10 border-b border-line p-16">
        <h2 class="text-12 font-semibold text-fg-primary">Incident window</h2>
        <Show
          when={!props.isLoading && props.analysis}
          fallback={
            <div class="grid grid-cols-3 gap-8">
              <Skeleton class="h-48 w-full" />
              <Skeleton class="h-48 w-full" />
              <Skeleton class="h-48 w-full" />
            </div>
          }
        >
          {(analysis) => (
            <>
              <div class="grid grid-cols-3 gap-8">
                <Statistic title="Errors" value={analysis().summary.totalErrors} />
                <Statistic title="Traces" value={analysis().summary.affectedTraces} />
                <Statistic title="Signatures" value={analysis().summary.uniqueSignatures} />
              </div>
              <Show when={analysis().summary.lastSeen}>
                {(lastSeen) => (
                  <StatChip
                    icon={<Clock3 class="h-14 w-14" size={14} />}
                    label="Last seen"
                    value={formatDateTime(lastSeen())}
                  />
                )}
              </Show>
            </>
          )}
        </Show>
      </section>

      <section class="shrink-0 space-y-8 border-b border-line p-16">
        <div class="flex items-center gap-8 text-12 font-semibold text-fg-primary">
          <Activity class="h-14 w-14 text-danger" size={14} />
          Error pulse
        </div>
        <Show
          when={!props.isLoading && props.analysis && hasPulse()}
          fallback={
            <Show when={props.isLoading} fallback={<p class="text-11 text-fg-tertiary">No errors in this window.</p>}>
              <Skeleton class="h-96 w-full" />
            </Show>
          }
        >
          <Chart.Cartesian labels={labels()} height={96} formatX={dayTick}>
            <Chart.Bars
              series={[
                {
                  key: "errors",
                  name: "errors",
                  color: "var(--danger)",
                  values: values(),
                },
              ]}
            />
          </Chart.Cartesian>
        </Show>
      </section>

      <Show when={props.analysis && props.analysis.models.length > 0}>
        <section class="shrink-0 space-y-8 border-b border-line p-16">
          <div class="flex items-center gap-8 text-12 font-semibold text-fg-primary">
            <GitBranch class="h-14 w-14" size={14} />
            Models involved
          </div>
          <div class="flex flex-wrap gap-6">
            <For each={props.analysis!.models}>
              {(item) => (
                <span class="rounded border border-line bg-surface-inset px-8 py-4 font-mono text-10 text-fg-secondary">
                  {item.model} · {item.count}
                </span>
              )}
            </For>
          </div>
        </section>
      </Show>

      <section class="min-h-0 flex-1">
        <div class="flex shrink-0 items-center gap-8 border-b border-line px-16 py-10">
          <Fingerprint class="h-14 w-14 text-danger" size={14} />
          <div class="min-w-0">
            <h2 class="text-12 font-semibold text-fg-primary">Error fingerprints</h2>
            <p class="text-10 text-fg-tertiary">
              {(props.analysis?.groups.length ?? 0).toLocaleString()} recurring signatures
            </p>
          </div>
        </div>

        <div class="p-8">
          <Show
            when={!props.isLoading && props.analysis}
            fallback={
              <div class="space-y-8">
                <For each={Array.from({ length: 4 }, (_, index) => index)}>
                  {() => <Skeleton class="h-48 w-full" />}
                </For>
              </div>
            }
          >
            {(analysis) => (
              <Show
                when={analysis().groups.length > 0}
                fallback={<p class="px-8 py-16 text-11 text-fg-tertiary">No recurring signatures in this window.</p>}
              >
                <div class="space-y-4">
                  <For each={analysis().groups}>
                    {(group) => (
                      <button
                        type="button"
                        onClick={() => props.onSelectSignature(group.signature)}
                        title={group.signature}
                        class={cn(
                          "w-full rounded-md border px-10 py-8 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                          props.search === group.signature
                            ? "border-danger/30 bg-danger-subtle"
                            : "border-transparent hover:border-danger/20 hover:bg-danger-subtle/70",
                        )}
                      >
                        <div class="line-clamp-2 min-w-0 break-words font-mono text-13 leading-normal text-fg-primary">
                          {group.signature}
                        </div>
                        <div class="mt-4 flex items-center gap-8 text-11 text-fg-tertiary">
                          <span class="font-semibold text-danger">{group.count} hits</span>
                          <span>·</span>
                          <span>{group.traceCount} traces</span>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </Show>
        </div>
      </section>
    </div>
  );
};
