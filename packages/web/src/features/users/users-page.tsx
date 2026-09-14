/**
 * Users list — filters + table; rows link to traces pre-filtered by userId.
 */

import {
  Button,
  DateFilterInput,
  EmptyState,
  FilterInput,
  type FilterInputHandle,
  PageHeaderShell,
  PaginationControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableInlineError,
  TableLoadingRows,
  TableRow,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { Globe, Search } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { useTableState } from "@/features/users/use-table-state";
import { useUsersQuery } from "@/shared/hooks/queries";
import { formatDateTime, formatNumber, formatTokens } from "@/shared/lib/format";
import type { UserRow } from "@/shared/lib/types";

const PAGE_SIZE = 25;

type UserFilters = {
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

function tracesHref(userId: string, filters: UserFilters) {
  const params = new URLSearchParams();
  params.set("userId", userId);
  if (filters.environment) params.set("environment", filters.environment);
  if (filters.fromTimestamp) params.set("fromTimestamp", filters.fromTimestamp);
  if (filters.toTimestamp) params.set("toTimestamp", filters.toTimestamp);
  return `/traces?${params.toString()}`;
}

export const UsersPage: Component = () => {
  let userFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;
  const tableState = useTableState<UserFilters>({
    filterKeys: ["userId", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "lastSeen.desc",
  });

  const query = useUsersQuery({
    page: tableState.page(),
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy(),
    ...tableState.filters(),
  });

  const users = () => (query.data?.data ?? []) as UserRow[];

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Users"
        description="End users and usage derived from traces in the selected window."
      />

      <div class="flex flex-wrap items-center gap-2 px-6 py-3">
        <FilterInput
          ref={(handle) => {
            userFilterRef = handle;
          }}
          class="w-52"
          placeholder="Filter by user id…"
          icon={Search}
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
          title="User activity start date"
          boundary="start"
        />
        <DateFilterInput
          class="w-36"
          value={tableState.filters().toTimestamp}
          onCommit={(v) => tableState.setFilter("toTimestamp", v)}
          placeholder="To date…"
          title="User activity end date"
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

      <Show when={!query.isPending} fallback={<TableLoadingRows class="flex-1 px-4" columns={6} />}>
        <Show
          when={!query.isError}
          fallback={
            <div class="px-4 py-3">
              <TableInlineError error={query.error} onRetry={() => void query.refetch()} />
            </div>
          }
        >
          <Show
            when={users().length > 0}
            fallback={
              <EmptyState
                variant="inline"
                class="mx-4 flex-1"
                title={
                  tableState.activeFilterCount() > 0
                    ? "No users match the current filters."
                    : "No users found."
                }
              />
            }
          >
            <div class="flex-1 overflow-auto px-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>First seen</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead class="text-right">Traces</TableHead>
                    <TableHead class="text-right">Observations</TableHead>
                    <TableHead class="text-right">Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <For each={users()}>
                    {(u) => (
                      <TableRow>
                        <TableCell class="max-w-[240px]">
                          <A
                            href={tracesHref(u.id, tableState.filters())}
                            class="truncate font-medium text-brand hover:underline"
                            title={`View traces for ${u.id}`}
                          >
                            {u.id}
                          </A>
                        </TableCell>
                        <TableCell class="whitespace-nowrap text-fg-tertiary">
                          {formatDateTime(u.firstSeen)}
                        </TableCell>
                        <TableCell class="whitespace-nowrap text-fg-tertiary">
                          {formatDateTime(u.lastSeen)}
                        </TableCell>
                        <TableCell class="tnum text-right">{formatNumber(u.countTraces)}</TableCell>
                        <TableCell class="tnum text-right">
                          {formatNumber(u.countObservations)}
                        </TableCell>
                        <TableCell class="tnum text-right">{formatTokens(u.totalTokens)}</TableCell>
                      </TableRow>
                    )}
                  </For>
                </TableBody>
              </Table>
            </div>
            <div class="border-t border-border px-4 py-2">
              <PaginationControls
                current={tableState.page()}
                pageSize={PAGE_SIZE}
                total={query.data?.meta.totalItems ?? 0}
                onChange={(page) => tableState.setPage(page)}
              />
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};
