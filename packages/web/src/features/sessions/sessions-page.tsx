/**
 * Sessions table — derived from traces.session_id in lite mode.
 */

import {
  Badge,
  Button,
  DateFilterInput,
  EmptyState,
  EnhancedDataTable,
  type EnhancedDataTableColumn,
  FilterInput,
  type FilterInputHandle,
  LocalIsoDate,
  PageHeaderShell,
  Skeleton,
  TableInlineError,
  TokenUsageBadge,
  TruncatedIdCell,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { Globe, Search, User } from "lucide-solid";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { SessionSearchDialog } from "@/features/sessions/session-search-dialog";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { useTableState } from "@/features/users/use-table-state";
import { useSessionsQuery } from "@/shared/hooks/queries";
import { formatIntervalSeconds, numberFormatter } from "@/shared/lib/format";
import type { SessionRow } from "@/shared/lib/types";

const PAGE_SIZE = 50;

type SessionsTableRow = {
  id: string;
  createdAt: string;
  countTraces: number;
  sessionDuration: number | null;
  userIds: string[];
  traceTags: string[];
  environment: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
};

type SessionFilters = {
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

function toRow(s: SessionRow): SessionsTableRow {
  return {
    id: s.id,
    createdAt: s.createdAt,
    countTraces: s.countTraces,
    sessionDuration: s.sessionDuration,
    userIds: s.userIds,
    traceTags: s.traceTags,
    environment: s.environment,
    inputTokens: s.promptTokens,
    outputTokens: s.completionTokens,
    totalTokens: s.totalTokens,
    cachedTokens: s.cachedTokens,
  };
}

const columns: EnhancedDataTableColumn<SessionsTableRow>[] = [
  {
    id: "id",
    header: "ID",
    accessor: (row) => row.id,
    sortable: true,
    cell: (row) => (
      <A
        href={`/sessions/${encodeURIComponent(row.id)}`}
        class="text-brand hover:underline"
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <TruncatedIdCell value={row.id} />
      </A>
    ),
  },
  {
    id: "createdAt",
    header: "Created At",
    accessor: (row) => row.createdAt,
    sortable: true,
    cell: (row) => (row.createdAt ? <LocalIsoDate date={new Date(row.createdAt)} /> : null),
  },
  {
    id: "sessionDuration",
    header: "Duration",
    accessor: (row) => row.sessionDuration,
    sortable: true,
    cell: (row) =>
      row.sessionDuration !== null && row.sessionDuration !== undefined
        ? formatIntervalSeconds(row.sessionDuration)
        : null,
  },
  {
    id: "environment",
    header: "Environment",
    accessor: (row) => row.environment,
    cell: (row) =>
      row.environment ? (
        <Badge class="max-w-fit truncate rounded-sm px-1 font-normal" title={row.environment}>
          {row.environment}
        </Badge>
      ) : null,
  },
  {
    id: "userIds",
    header: "User IDs",
    accessor: (row) => row.userIds.join(","),
    cell: (row) =>
      row.userIds.length > 0 ? (
        <div class="flex flex-wrap gap-1">
          {row.userIds.map((user) => (
            <span>
              <TruncatedIdCell value={user} />
            </span>
          ))}
        </div>
      ) : null,
  },
  {
    id: "countTraces",
    header: "Traces",
    accessor: (row) => row.countTraces,
    sortable: true,
    cell: (row) => (row.countTraces ? <span>{numberFormatter(row.countTraces, 0)}</span> : null),
  },
  {
    id: "inputTokens",
    header: "Input Tokens",
    accessor: (row) => row.inputTokens,
    hideable: true,
    cell: (row) => (row.inputTokens ? <span>{numberFormatter(row.inputTokens, 0)}</span> : null),
  },
  {
    id: "outputTokens",
    header: "Output Tokens",
    accessor: (row) => row.outputTokens,
    hideable: true,
    cell: (row) => (row.outputTokens ? <span>{numberFormatter(row.outputTokens, 0)}</span> : null),
  },
  {
    id: "totalTokens",
    header: "Total Tokens",
    accessor: (row) => row.totalTokens,
    hideable: true,
    cell: (row) => (row.totalTokens ? <span>{numberFormatter(row.totalTokens, 0)}</span> : null),
  },
  {
    id: "cachedTokens",
    header: "Cached Tokens",
    accessor: (row) => row.cachedTokens,
    hideable: true,
    cell: (row) => (row.cachedTokens ? <span>{numberFormatter(row.cachedTokens, 0)}</span> : null),
  },
  {
    id: "usage",
    header: "Usage",
    accessor: (row) => row.totalTokens,
    cell: (row) => (
      <TokenUsageBadge
        inputUsage={row.inputTokens}
        outputUsage={row.outputTokens}
        totalUsage={row.totalTokens}
        inline
      />
    ),
  },
  {
    id: "traceTags",
    header: "Trace Tags",
    accessor: (row) => row.traceTags.join(","),
    hideable: true,
    cell: (row) =>
      row.traceTags.length > 0 ? (
        <div class="flex flex-wrap gap-x-2 gap-y-1">
          {row.traceTags.map((tag) => (
            <Badge class="font-normal">{tag}</Badge>
          ))}
        </div>
      ) : null,
  },
];

export const SessionsPage: Component = () => {
  const [searchOpen, setSearchOpen] = createSignal(false);
  let userFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;

  const tableState = useTableState<SessionFilters>({
    filterKeys: ["userId", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "createdAt.desc",
  });

  const query = useSessionsQuery({
    page: tableState.page(),
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy(),
    ...tableState.filters(),
  });

  const rows = createMemo(() => (query.data?.data ?? []).map(toRow));

  const toolbar = () => (
    <div class="flex flex-wrap items-center gap-2">
      <FilterInput
        ref={(handle) => {
          userFilterRef = handle;
        }}
        class="w-44"
        placeholder="Filter by userId…"
        icon={User}
        value={tableState.filters().userId}
        onCommit={(v) => tableState.setFilter("userId", v)}
      />
      <FilterInput
        ref={(handle) => {
          environmentFilterRef = handle;
        }}
        class="w-44"
        placeholder="Filter by environment…"
        icon={Globe}
        value={tableState.filters().environment}
        onCommit={(v) => tableState.setFilter("environment", v)}
      />
      <DateFilterInput
        class="w-36"
        value={tableState.filters().fromTimestamp}
        onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
        placeholder="From date…"
        title="Session activity start date"
        boundary="start"
      />
      <DateFilterInput
        class="w-36"
        value={tableState.filters().toTimestamp}
        onCommit={(v) => tableState.setFilter("toTimestamp", v)}
        placeholder="To date…"
        title="Session activity end date"
        boundary="end"
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          userFilterRef?.commit();
          environmentFilterRef?.commit();
        }}
      >
        <Search class="h-4 w-4" size={16} />
        Search
      </Button>
      <Show when={tableState.activeFilterCount() > 0}>
        <Button size="sm" variant="ghost" onClick={tableState.clearFilters}>
          <Search class="h-4 w-4" size={16} />
          Clear ({tableState.activeFilterCount()})
        </Button>
      </Show>
      <div class="ml-auto">
        <AutoRefreshControl />
      </div>
    </div>
  );

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Sessions"
        description="Groups of traces and usage in the selected window."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setSearchOpen(true)}>
            <Search size={16} />
            Search sessions
          </Button>
        }
      />

      <div class="flex flex-1 flex-col overflow-hidden px-4 py-3">
        <Show
          when={!query.isPending}
          fallback={
            <div class="space-y-2">
              <Skeleton class="h-9 w-full" />
              <For each={Array.from({ length: 8 }, (_, i) => i)}>
                {() => <Skeleton class="h-9 w-full" />}
              </For>
            </div>
          }
        >
          <Show
            when={!query.isError}
            fallback={<TableInlineError error={query.error} onRetry={() => void query.refetch()} />}
          >
            <Show
              when={rows().length > 0}
              fallback={
                <EmptyState
                  variant="inline"
                  title={
                    tableState.activeFilterCount() > 0
                      ? "No sessions match the current filters."
                      : "No sessions found."
                  }
                />
              }
            >
              <EnhancedDataTable
                data={rows()}
                columns={columns}
                rowKey={(row) => row.id}
                serverSort
                sort={tableState.dataTableSort()}
                onSortChange={tableState.setDataTableSort}
                pagination={{
                  current: tableState.page(),
                  pageSize: PAGE_SIZE,
                  total: query.data?.meta.totalItems ?? 0,
                  onChange: (page) => tableState.setPage(page),
                }}
                toolbar={toolbar()}
                showColumnToggle
                class="min-h-0 flex-1"
              />
            </Show>
          </Show>
        </Show>
      </div>

      <SessionSearchDialog open={searchOpen()} onOpenChange={setSearchOpen} />
    </div>
  );
};
