/**
 * Traces table — core list query + per-page metrics join, URL-synced filters/sort/page,
 * and a peek side panel with J/K row navigation.
 */

import {
  Button,
  DateFilterInput,
  EmptyState,
  FilterInput,
  type FilterInputHandle,
  InlineForm,
  PageHeaderShell,
  Sheet,
  SheetContent,
  Skeleton,
  TableInlineError,
  TableView,
} from "@peri/ui";
import { useSearchParams } from "@solidjs/router";
import { Globe, Search, User } from "lucide-solid";
import { type Component, createEffect, createMemo, onCleanup, Show } from "solid-js";
import { joinCoreAndMetrics } from "@/features/traces/join-core-metrics";
import { TracePeekView } from "@/features/traces/trace-peek-view";
import { tracesTableColumns } from "@/features/traces/traces-table-columns";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { searchParamValue } from "@/features/users/search-param";
import { useTableState } from "@/features/users/use-table-state";
import { useTracesMetricsQuery, useTracesQuery } from "@/shared/hooks/queries";

const PAGE_SIZE = 50;

type TraceFilters = {
  name?: string;
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

export const TracesPage: Component = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  let nameFilterRef: FilterInputHandle | undefined;
  let userIdFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;

  const peekedTraceId = () => searchParamValue(searchParams.peek);

  const setPeek = (id: string | null) => {
    setSearchParams({ peek: id ?? undefined }, { replace: true });
  };

  const tableState = useTableState<TraceFilters>({
    filterKeys: ["name", "userId", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "timestamp.desc",
  });

  const coreQuery = useTracesQuery(() => ({
    page: tableState.page(),
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy(),
    ...tableState.filters(),
  }));

  const traceIds = createMemo(() => (coreQuery.data?.data ?? []).map((trace) => trace.id));
  const metricsQuery = useTracesMetricsQuery(() => traceIds());
  const rows = createMemo(() => joinCoreAndMetrics(coreQuery.data?.data ?? [], metricsQuery.data));

  createEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const ids = rows().map((row) => row.id);
      const peek = peekedTraceId();

      if (event.key === "j" || event.key === "k") {
        if (ids.length === 0) return;
        event.preventDefault();
        const index = peek ? ids.indexOf(peek) : -1;
        const next =
          event.key === "j"
            ? Math.min(index + 1, ids.length - 1)
            : Math.max(index <= 0 ? 0 : index - 1, 0);
        setPeek(ids[next]!);
      } else if (event.key === "Escape" && peek) {
        setPeek(null);
      }
    };

    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  const handleTableClick = (event: MouseEvent) => {
    const row = (event.target as HTMLElement).closest("[data-row-key]");
    if (!row) return;
    const key = row.getAttribute("data-row-key");
    if (key) setPeek(key);
  };

  const toolbar = () => (
    <InlineForm
      class="min-w-0 flex-1"
      minTrack={144}
      gap={8}
      onSubmit={() => {
        nameFilterRef?.commit();
        userIdFilterRef?.commit();
        environmentFilterRef?.commit();
      }}
    >
      <InlineForm.Field span={2}>
        <FilterInput
          ref={(handle) => {
            nameFilterRef = handle;
          }}
          placeholder="Filter by name…"
          icon={Search}
          value={tableState.filters().name}
          onCommit={(value) => tableState.setFilter("name", value)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <FilterInput
          ref={(handle) => {
            userIdFilterRef = handle;
          }}
          placeholder="Filter by userId…"
          icon={User}
          value={tableState.filters().userId}
          onCommit={(value) => tableState.setFilter("userId", value)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <FilterInput
          ref={(handle) => {
            environmentFilterRef = handle;
          }}
          placeholder="Filter by environment…"
          icon={Globe}
          value={tableState.filters().environment}
          onCommit={(value) => tableState.setFilter("environment", value)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          title="From timestamp"
          boundary="start"
          placeholder="From date"
          value={tableState.filters().fromTimestamp}
          onCommit={(value) => tableState.setFilter("fromTimestamp", value)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          title="To timestamp"
          boundary="end"
          placeholder="To date"
          value={tableState.filters().toTimestamp}
          onCommit={(value) => tableState.setFilter("toTimestamp", value)}
        />
      </InlineForm.Field>
      <InlineForm.Actions>
        <Button type="submit" size="sm" variant="secondary">
          <Search class="h-16 w-16" size={16} />
          Search
        </Button>
        <Show when={tableState.activeFilterCount() > 0}>
          <Button size="sm" variant="ghost" onClick={tableState.clearFilters}>
            Clear ({tableState.activeFilterCount()})
          </Button>
        </Show>
        <AutoRefreshControl />
      </InlineForm.Actions>
    </InlineForm>
  );

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeaderShell title="Traces" description="All traces ingested into this lite project." />

      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-16 py-12">
          <Show
            when={!coreQuery.isPending}
            fallback={
              <div class="space-y-8">
                <Skeleton class="h-36 w-full" />
                <Skeleton class="h-256 w-full" />
              </div>
            }
          >
            <Show
              when={!coreQuery.isError && !metricsQuery.isError}
              fallback={
                <TableInlineError
                  error={coreQuery.error ?? metricsQuery.error}
                  onRetry={() => {
                    void coreQuery.refetch();
                    void metricsQuery.refetch();
                  }}
                />
              }
            >
              <Show
                when={rows().length > 0}
                fallback={
                  <EmptyState
                    variant="inline"
                    title={
                      tableState.activeFilterCount() > 0
                        ? "No traces match the current filters."
                        : "No traces found."
                    }
                  />
                }
              >
                <div
                  class="traces-table flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  onClick={handleTableClick}
                  style={{
                    "--peek-row-bg": "var(--brand-subtle)",
                  }}
                >
                  <style>{`
                    .traces-table [data-row-key="${peekedTraceId() ?? ""}"] {
                      background: var(--brand-subtle);
                      box-shadow: inset 2px 0 0 0 var(--brand);
                    }
                    .traces-table [data-row-key] {
                      cursor: pointer;
                    }
                  `}</style>
                  <TableView.ServerTable
                    data={rows()}
                    columns={tracesTableColumns}
                    rowKey={(row) => row.id}
                    serverSort
                    sort={tableState.dataTableSort()}
                    onSortChange={tableState.setDataTableSort}
                    pagination={{
                      current: tableState.page(),
                      pageSize: PAGE_SIZE,
                      total: coreQuery.data?.meta.totalItems ?? 0,
                      onChange: (page) => tableState.setPage(page),
                    }}
                    toolbar={toolbar()}
                    showColumnToggle
                    class="min-h-0 flex-1"
                  />
                </div>
              </Show>
            </Show>
          </Show>
      </div>

      <Show when={peekedTraceId()}>
        {(traceId) => (
          <Sheet open onOpenChange={(open) => !open && setPeek(null)}>
            <SheetContent side="right" class="w-1/2 gap-0 p-0">
              <TracePeekView traceId={traceId()} onClose={() => setPeek(null)} />
            </SheetContent>
          </Sheet>
        )}
      </Show>
    </div>
  );
};
