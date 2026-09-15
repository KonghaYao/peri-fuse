import {
  Button,
  DateFilterInput,
  EmptyState,
  TableView,
  FilterInput,
  type FilterInputHandle,
  FilterSelect,
  InlineForm,
  PageHeaderShell,
  Skeleton,
  TableInlineError,
} from "@peri/ui";
import { Globe, Search } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import { observationsTableColumns } from "@/features/observations/observations-table-columns";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { useTableState } from "@/features/users/use-table-state";
import { useObservationsQuery } from "@/shared/hooks/queries";
import type { Observation } from "@/shared/lib/types";

const PAGE_SIZE = 25;

type ObservationFilters = {
  name?: string;
  type?: string;
  level?: string;
  environment?: string;
  fromStartTime?: string;
  toStartTime?: string;
};

export const ObservationsPage: Component = () => {
  let nameFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;

  const tableState = useTableState<ObservationFilters>({
    filterKeys: ["name", "type", "level", "environment", "fromStartTime", "toStartTime"],
    defaultSort: "startTime.desc",
  });

  const query = useObservationsQuery(() => ({
    page: tableState.page(),
    limit: PAGE_SIZE,
    ...tableState.filters(),
  }));

  const observations = () => (query.data?.data ?? []) as Observation[];

  const toolbar = () => (
    <InlineForm
      class="min-w-0 flex-1"
      minTrack={144}
      gap={8}
      onSubmit={() => {
        nameFilterRef?.commit();
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
          onCommit={(v) => tableState.setFilter("name", v)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <FilterSelect
          class="w-full"
          placeholder="Type"
          allLabel="All types"
          value={tableState.filters().type}
          onCommit={(v) => tableState.setFilter("type", v)}
          options={[
            { value: "SPAN", label: "SPAN" },
            { value: "GENERATION", label: "GENERATION" },
            { value: "EVENT", label: "EVENT" },
          ]}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <FilterInput
          ref={(handle) => {
            environmentFilterRef = handle;
          }}
          placeholder="Environment…"
          icon={Globe}
          value={tableState.filters().environment}
          onCommit={(v) => tableState.setFilter("environment", v)}
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          value={tableState.filters().fromStartTime}
          onCommit={(v) => tableState.setFilter("fromStartTime", v)}
          placeholder="From date…"
          title="Observation start date"
          boundary="start"
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          value={tableState.filters().toStartTime}
          onCommit={(v) => tableState.setFilter("toStartTime", v)}
          placeholder="To date…"
          title="Observation end date"
          boundary="end"
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <FilterSelect
          class="w-full"
          placeholder="Level"
          allLabel="All levels"
          value={tableState.filters().level}
          onCommit={(v) => tableState.setFilter("level", v)}
          options={[
            { value: "DEBUG", label: "DEBUG" },
            { value: "DEFAULT", label: "DEFAULT" },
            { value: "WARNING", label: "WARNING" },
            { value: "ERROR", label: "ERROR" },
          ]}
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
        title="Observations"
        description="Spans, generations and events across all traces."
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
              when={observations().length > 0}
              fallback={
                <EmptyState
                  variant="inline"
                  title={
                    tableState.activeFilterCount() > 0
                      ? "No observations match the current filters."
                      : "No observations found."
                  }
                />
              }
            >
              <TableView.ServerTable
                data={observations()}
                columns={observationsTableColumns}
                rowKey={(row) => row.id}
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
