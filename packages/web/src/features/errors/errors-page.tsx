import {
  Button,
  EmptyState,
  TableView,
  type FilterInputHandle,
  PageHeaderShell,
  Skeleton,
  TableInlineError,
} from "@peri/ui";
import { useSearchParams } from "@solidjs/router";
import { Clock3 } from "lucide-solid";
import { type Component, createMemo, createSignal, Show } from "solid-js";
import { ErrorInvestigationPanel } from "@/features/errors/components/error-investigation-panel";
import { ErrorOperationsRail } from "@/features/errors/components/error-operations-rail";
import { errorsTableColumns } from "@/features/errors/errors-table-columns";
import { searchParamValue } from "@/features/users/search-param";
import { useErrorsQuery } from "@/shared/hooks/queries";
import type { ErrorQueryParams } from "@/shared/lib/types";

const RANGE_MS: Record<string, number | null> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
  all: null,
};

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

  const queryParams = createMemo((): ErrorQueryParams => {
    const duration = RANGE_MS[range()] ?? RANGE_MS["7d"];
    return {
      from: duration === null ? undefined : new Date(clock() - duration).toISOString(),
      search: search(),
      type: type(),
      model: model(),
      environment: environment(),
    };
  });

  const query = useErrorsQuery(() => queryParams());
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

  const commitFilters = () => {
    searchRef?.commit();
    environmentRef?.commit();
  };

  const handleTableClick = (event: MouseEvent) => {
    const row = (event.target as HTMLElement).closest("[data-row-key]");
    if (!row) return;
    const key = row.getAttribute("data-row-key");
    if (key) selectError(key);
  };

  const operationsRail = () => (
    <ErrorOperationsRail
      analysis={analysis()}
      range={range()}
      search={search()}
      type={type()}
      model={model()}
      environment={environment()}
      hasActiveFilters={hasActiveFilters()}
      isLoading={query.isPending}
      onRangeChange={(value) => updateFilter("range", value)}
      onFilterChange={updateFilter}
      onSearchCommit={commitFilters}
      onClearFilters={clearFilters}
      onSelectSignature={(signature) => updateFilter("search", signature)}
      bindSearchRef={(handle) => {
        searchRef = handle;
      }}
      bindEnvironmentRef={(handle) => {
        environmentRef = handle;
      }}
    />
  );

  const toolbar = () => (
    <Show when={query.hasNextPage}>
      <Button
        size="sm"
        variant="secondary"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        {query.isFetchingNextPage ? "Loading…" : "Load older errors"}
      </Button>
    </Show>
  );

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeaderShell
        title="Errors"
        description="Find recurring failures and follow their evidence back to the source."
      />

      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside class="hidden w-300 shrink-0 overflow-y-auto border-r border-line bg-surface-raised lg:block">
          {operationsRail()}
        </aside>

        <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-16 py-12">
            <details class="mb-12 shrink-0 rounded-md border border-line bg-surface-raised lg:hidden">
              <summary class="cursor-pointer px-16 py-10 text-11 font-semibold text-fg-secondary">
                Filters & analysis
              </summary>
              {operationsRail()}
            </details>

            <div class="mb-8 flex shrink-0 items-center justify-between gap-8 border-b border-line pb-8">
              <div class="flex items-center gap-8 text-11 text-fg-secondary">
                <Clock3 class="h-14 w-14" size={14} />
                <span>
                  {analysis()
                    ? `${analysis()!.summary.totalErrors.toLocaleString()} matching errors`
                    : "Loading errors"}
                </span>
                <span class="font-mono text-10 text-fg-tertiary">Newest first</span>
              </div>
            </div>

            <Show
              when={!query.isPending}
              fallback={
                <div class="space-y-8">
                  <Skeleton class="h-36 w-full" />
                  <Skeleton class="h-256 w-full" />
                </div>
              }
            >
              <Show
                when={!query.isError}
                fallback={
                  <TableInlineError error={query.error} onRetry={() => void query.refetch()} />
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
                  <div
                    class="errors-table flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    onClick={handleTableClick}
                    style={{ "--peek-row-bg": "var(--danger-subtle)" }}
                  >
                    <style>{`
                      .errors-table [data-row-key="${selectedId() ?? ""}"] {
                        background: var(--danger-subtle);
                        box-shadow: inset 2px 0 0 0 var(--danger);
                      }
                      .errors-table [data-row-key] {
                        cursor: pointer;
                      }
                    `}</style>
                    <TableView.ServerTable
                      data={errors()}
                      columns={errorsTableColumns}
                      rowKey={(row) => row.id}
                      toolbar={toolbar()}
                      showColumnToggle
                      class="min-h-0 flex-1"
                    />
                  </div>
                </Show>
              </Show>
            </Show>
          </div>

          <Show when={selected()} keyed>
            {(error) => (
              <ErrorInvestigationPanel error={error} onClose={() => selectError(undefined)} />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};
