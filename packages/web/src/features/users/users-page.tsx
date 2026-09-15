/**
 * Users list — filters + table; rows link to traces pre-filtered by userId.
 */

import {
  Button,
  DateFilterInput,
  EmptyState,
  TableView,
  FilterInput,
  type FilterInputHandle,
  InlineForm,
  PageHeaderShell,
  Skeleton,
  TableInlineError,
} from "@peri/ui";
import { Globe, Search } from "lucide-solid";
import { type Component, createMemo, For, Show } from "solid-js";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { createUsersTableColumns } from "@/features/users/users-table-columns";
import { useTableState } from "@/features/users/use-table-state";
import { useUsersQuery } from "@/shared/hooks/queries";
import type { UserRow } from "@/shared/lib/types";

const PAGE_SIZE = 25;

type UserFilters = {
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

export const UsersPage: Component = () => {
  let userFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;
  const tableState = useTableState<UserFilters>({
    filterKeys: ["userId", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "lastSeen.desc",
  });

  const query = useUsersQuery(() => ({
    page: tableState.page(),
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy(),
    ...tableState.filters(),
  }));

  const users = () => (query.data?.data ?? []) as UserRow[];
  const columns = createMemo(() => createUsersTableColumns(() => tableState.filters()));

  const toolbar = () => (
    <InlineForm
      class="min-w-0 flex-1"
      minTrack={144}
      gap={8}
      onSubmit={() => {
        userFilterRef?.commit();
        environmentFilterRef?.commit();
      }}
    >
      <InlineForm.Field span={2}>
        <FilterInput
          ref={(handle) => {
            userFilterRef = handle;
          }}
          placeholder="Filter by user id…"
          icon={Search}
          value={tableState.filters().userId}
          onCommit={(v) => tableState.setFilter("userId", v)}
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
          onCommit={(v) => tableState.setFilter("environment", v)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          value={tableState.filters().fromTimestamp}
          onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
          placeholder="From date…"
          title="User activity start date"
          boundary="start"
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          value={tableState.filters().toTimestamp}
          onCommit={(v) => tableState.setFilter("toTimestamp", v)}
          placeholder="To date…"
          title="User activity end date"
          boundary="end"
        />
      </InlineForm.Field>
      <InlineForm.Actions>
        <Button type="submit" size="sm" variant="secondary">
          <Search class="h-16 w-16" size={16} />
          Search
        </Button>
        <Show when={tableState.activeFilterCount() > 0}>
          <Button size="sm" variant="ghost" onClick={tableState.clearFilters}>
            <Search class="h-16 w-16" size={16} />
            Clear ({tableState.activeFilterCount()})
          </Button>
        </Show>
        <AutoRefreshControl />
      </InlineForm.Actions>
    </InlineForm>
  );

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Users"
        description="End users and usage derived from traces in the selected window."
      />

      <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-16 py-12">
        <Show
          when={!query.isPending}
          fallback={
            <div class="space-y-8">
              <Skeleton class="h-36 w-full" />
              <For each={Array.from({ length: 8 }, (_, i) => i)}>
                {() => <Skeleton class="h-36 w-full" />}
              </For>
            </div>
          }
        >
          <Show
            when={!query.isError}
            fallback={<TableInlineError error={query.error} onRetry={() => void query.refetch()} />}
          >
            <Show
              when={users().length > 0}
              fallback={
                <EmptyState
                  variant="inline"
                  title={
                    tableState.activeFilterCount() > 0
                      ? "No users match the current filters."
                      : "No users found."
                  }
                />
              }
            >
              <TableView.ServerTable
                data={users()}
                columns={columns()}
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
    </div>
  );
};
