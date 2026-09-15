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
import { scoresTableColumns } from "@/features/scores/scores-table-columns";
import { AutoRefreshControl } from "@/features/users/components/auto-refresh-control";
import { useTableState } from "@/features/users/use-table-state";
import { useScoresQuery } from "@/shared/hooks/queries";
import type { Score } from "@/shared/lib/types";

const PAGE_SIZE = 25;

type ScoreFilters = {
  name?: string;
  source?: string;
  dataType?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

export const ScoresPage: Component = () => {
  let nameFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;

  const tableState = useTableState<ScoreFilters>({
    filterKeys: ["name", "source", "dataType", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "timestamp.desc",
  });

  const query = useScoresQuery(() => ({
    page: tableState.page(),
    limit: PAGE_SIZE,
    ...tableState.filters(),
  }));

  const scores = () => (query.data?.data ?? []) as Score[];

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
          placeholder="Source"
          allLabel="All sources"
          value={tableState.filters().source}
          onCommit={(v) => tableState.setFilter("source", v)}
          options={[
            { value: "API", label: "API" },
            { value: "EVAL", label: "EVAL" },
            { value: "ANNOTATION", label: "ANNOTATION" },
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
          value={tableState.filters().fromTimestamp}
          onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
          placeholder="From date…"
          title="Score start date"
          boundary="start"
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <DateFilterInput
          value={tableState.filters().toTimestamp}
          onCommit={(v) => tableState.setFilter("toTimestamp", v)}
          placeholder="To date…"
          title="Score end date"
          boundary="end"
        />
      </InlineForm.Field>
      <InlineForm.Field>
        <FilterSelect
          class="w-full"
          placeholder="Data type"
          allLabel="All types"
          value={tableState.filters().dataType}
          onCommit={(v) => tableState.setFilter("dataType", v)}
          options={[
            { value: "NUMERIC", label: "NUMERIC" },
            { value: "CATEGORICAL", label: "CATEGORICAL" },
            { value: "BOOLEAN", label: "BOOLEAN" },
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
        title="Scores"
        description="Evaluation scores attached to traces and observations."
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
              when={scores().length > 0}
              fallback={
                <EmptyState
                  variant="inline"
                  title={
                    tableState.activeFilterCount() > 0
                      ? "No scores match the current filters."
                      : "No scores found."
                  }
                />
              }
            >
              <TableView.ServerTable
                data={scores()}
                columns={scoresTableColumns}
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
