import {
  Badge,
  Button,
  EmptyState,
  FilterInput,
  type FilterInputHandle,
  FilterSelect,
  PageHeaderShell,
  Skeleton,
  TableInlineError,
} from "@peri/ui";
import { useSearchParams } from "@solidjs/router";
import { AlertTriangle, ChevronRight, Clock3, Globe, Search, X } from "lucide-solid";
import { type Component, createSignal, For, Show } from "solid-js";
import { ErrorAnalysisRail } from "@/features/errors/components/error-analysis-rail";
import { ErrorInvestigationPanel } from "@/features/errors/components/error-investigation-panel";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { searchParamValue } from "@/features/users/search-param";
import { useErrorsQuery } from "@/shared/hooks/queries";
import { formatDateTime, formatDuration } from "@/shared/lib/format";
import type { ErrorEvent, ErrorQueryParams } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

const RANGE_MS: Record<string, number | null> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
  all: null,
};

const ErrorRow: Component<{
  error: ErrorEvent;
  selected: boolean;
  onSelect: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={props.onSelect}
    class={cn(
      "group grid w-full grid-cols-[18px_minmax(0,1fr)_auto] gap-3 border-b border-line px-4 py-3 text-left transition-colors focus-visible:bg-danger-subtle",
      props.selected ? "bg-danger-subtle" : "hover:bg-surface-inset/70",
    )}
  >
    <AlertTriangle class="mt-0.5 h-4 w-4 text-danger" size={16} />
    <div class="min-w-0">
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate text-sm font-semibold text-fg-primary">
          {props.error.name ?? "Unnamed observation"}
        </span>
        <Badge tone="neutral" class="shrink-0 font-mono text-[9px]">
          {props.error.type}
        </Badge>
        {props.error.model && (
          <span class="hidden truncate font-mono text-[10px] text-fg-tertiary sm:block">
            {props.error.model}
          </span>
        )}
      </div>
      <p class="mt-1 line-clamp-2 font-mono text-[11px] leading-4 text-fg-secondary">
        {props.error.statusMessage ?? "No status message recorded"}
      </p>
      <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-tertiary">
        <span>{props.error.traceName ?? props.error.traceId ?? "Unknown trace"}</span>
        {props.error.environment && <span>{props.error.environment}</span>}
        {props.error.endTime && (
          <span>{formatDuration(props.error.startTime, props.error.endTime)}</span>
        )}
      </div>
    </div>
    <div class="flex items-start gap-2">
      <time class="hidden whitespace-nowrap font-mono text-[10px] text-fg-tertiary sm:block">
        {formatDateTime(props.error.startTime)}
      </time>
      <ChevronRight
        class="h-4 w-4 text-fg-tertiary transition-transform group-hover:translate-x-0.5"
        size={16}
      />
    </div>
  </button>
);

export const ErrorsPage: Component = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clock] = createSignal(Date.now());
  let searchRef: FilterInputHandle | undefined;
  let environmentRef: FilterInputHandle | undefined;

  const range = () => searchParamValue(searchParams.range) ?? "7d";
  const search = () => searchParamValue(searchParams.search);
  const type = () => searchParamValue(searchParams.type);
  const model = () => searchParamValue(searchParams.model);
  const environment = () => searchParamValue(searchParams.environment);
  const selectedId = () => searchParamValue(searchParams.errorId);

  const queryParams = (): ErrorQueryParams => {
    const duration = RANGE_MS[range()] ?? RANGE_MS["7d"];
    return {
      from: duration === null ? undefined : new Date(clock() - duration).toISOString(),
      search: search(),
      type: type(),
      model: model(),
      environment: environment(),
    };
  };

  const query = useErrorsQuery(queryParams());
  const analysis = () => query.data?.pages[0];
  const errors = () => query.data?.pages.flatMap((page) => page.data) ?? [];
  const selected = () => errors().find((error) => error.id === selectedId());

  const updateFilter = (key: string, value: string | undefined) => {
    setSearchParams(
      {
        [key]: value ?? undefined,
        errorId: undefined,
      },
      { replace: true },
    );
  };

  const selectError = (id: string | undefined) => {
    setSearchParams({ errorId: id ?? undefined }, { replace: true });
  };

  const clearFilters = () => {
    setSearchParams({
      range: range(),
      search: undefined,
      type: undefined,
      model: undefined,
      environment: undefined,
      errorId: undefined,
    });
  };

  const hasActiveFilters = () => Boolean(search() || type() || model() || environment());

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeaderShell
        title="Errors"
        description="Find recurring failures and follow their evidence back to the source."
        actions={<AutoRefreshControl />}
      />

      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div class="flex rounded-md border border-line bg-surface-inset p-0.5">
          <For each={Object.keys(RANGE_MS)}>
            {(item) => (
              <button
                type="button"
                onClick={() => updateFilter("range", item)}
                class={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                  range() === item
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
          ref={(handle) => {
            searchRef = handle;
          }}
          class="w-64"
          placeholder="Search message, trace or name…"
          icon={Search}
          value={search()}
          onCommit={(value) => updateFilter("search", value)}
        />
        <FilterInput
          ref={(handle) => {
            environmentRef = handle;
          }}
          class="w-40"
          placeholder="Environment…"
          icon={Globe}
          value={environment()}
          onCommit={(value) => updateFilter("environment", value)}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            searchRef?.commit();
            environmentRef?.commit();
          }}
        >
          <Search class="h-3.5 w-3.5" size={14} /> Search
        </Button>
        <FilterSelect
          placeholder="Type"
          allLabel="All types"
          value={type()}
          onCommit={(value) => updateFilter("type", value)}
          options={["GENERATION", "SPAN", "EVENT", "AGENT", "TOOL"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <FilterSelect
          placeholder="Model"
          allLabel="All models"
          value={model()}
          onCommit={(value) => updateFilter("model", value)}
          options={(analysis()?.models ?? []).map((item) => ({
            value: item.model,
            label: `${item.model} (${item.count})`,
          }))}
        />
        <Show when={hasActiveFilters()}>
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X class="h-3.5 w-3.5" size={14} /> Clear filters
          </Button>
        </Show>
      </div>

      <div class="flex min-h-0 flex-1">
        <Show when={analysis()}>
          {(data) => (
            <aside class="hidden w-72 shrink-0 overflow-y-auto border-r border-line bg-surface-raised lg:block">
              <ErrorAnalysisRail
                analysis={data()}
                onSelectSignature={(signature) => updateFilter("search", signature)}
              />
            </aside>
          )}
        </Show>

        <main class="flex min-w-0 flex-1 flex-col">
          <Show when={analysis()}>
            {(data) => (
              <details class="shrink-0 border-b border-line bg-surface-raised lg:hidden">
                <summary class="cursor-pointer px-4 py-2.5 text-xs font-semibold text-fg-secondary">
                  Analysis snapshot · {data().summary.uniqueSignatures} fingerprints
                </summary>
                <ErrorAnalysisRail
                  analysis={data()}
                  onSelectSignature={(signature) => updateFilter("search", signature)}
                />
              </details>
            )}
          </Show>
          <div class="flex h-10 shrink-0 items-center justify-between border-b border-line px-4">
            <div class="flex items-center gap-2 text-xs text-fg-secondary">
              <Clock3 class="h-3.5 w-3.5" size={14} />
              <span>
                {analysis()
                  ? `${analysis()!.summary.totalErrors.toLocaleString()} matching errors`
                  : "Loading errors"}
              </span>
            </div>
            <span class="font-mono text-[10px] text-fg-tertiary">Newest first</span>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <Show
              when={!query.isPending}
              fallback={
                <div class="space-y-2 p-4">
                  <For each={Array.from({ length: 10 }, (_, i) => i)}>
                    {() => <Skeleton class="h-16 w-full" />}
                  </For>
                </div>
              }
            >
              <Show
                when={!query.isError}
                fallback={
                  <div class="p-4">
                    <TableInlineError error={query.error} onRetry={() => void query.refetch()} />
                  </div>
                }
              >
                <Show
                  when={errors().length > 0}
                  fallback={
                    <EmptyState
                      variant="inline"
                      title="No errors match this investigation window."
                    />
                  }
                >
                  <For each={errors()}>
                    {(error) => (
                      <ErrorRow
                        error={error}
                        selected={error.id === selectedId()}
                        onSelect={() => selectError(error.id)}
                      />
                    )}
                  </For>
                  <Show when={query.hasNextPage}>
                    <div class="flex justify-center p-4">
                      <Button
                        variant="secondary"
                        disabled={query.isFetchingNextPage}
                        onClick={() => void query.fetchNextPage()}
                      >
                        {query.isFetchingNextPage ? "Loading…" : "Load older errors"}
                      </Button>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
        </main>

        <Show when={selected()} keyed>
          {(error) => (
            <ErrorInvestigationPanel error={error} onClose={() => selectError(undefined)} />
          )}
        </Show>
      </div>
    </div>
  );
};
