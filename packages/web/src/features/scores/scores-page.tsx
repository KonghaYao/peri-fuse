import {
  Badge,
  Button,
  DateFilterInput,
  EmptyState,
  FilterInput,
  type FilterInputHandle,
  FilterSelect,
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
import { useScoresQuery } from "@/shared/hooks/queries";
import { formatDateTime } from "@/shared/lib/format";
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

function scoreDisplay(s: Score): string {
  if (s.stringValue !== null && s.stringValue !== undefined) return s.stringValue;
  if (s.value !== null && s.value !== undefined) {
    return Number.isInteger(s.value) ? String(s.value) : s.value.toFixed(4);
  }
  return "—";
}

export const ScoresPage: Component = () => {
  let nameFilterRef: FilterInputHandle | undefined;
  let environmentFilterRef: FilterInputHandle | undefined;

  const tableState = useTableState<ScoreFilters>({
    filterKeys: ["name", "source", "dataType", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "timestamp.desc",
  });

  const query = useScoresQuery({
    page: tableState.page(),
    limit: PAGE_SIZE,
    ...tableState.filters(),
  });

  const scores = () => (query.data?.data ?? []) as Score[];

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Scores"
        description="Evaluation scores attached to traces and observations."
      />

      <div class="flex flex-wrap items-center gap-2 px-6 py-3">
        <FilterInput
          ref={(handle) => {
            nameFilterRef = handle;
          }}
          class="w-52"
          placeholder="Filter by name…"
          icon={Search}
          value={tableState.filters().name}
          onCommit={(v) => tableState.setFilter("name", v)}
        />
        <FilterSelect
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
        <FilterInput
          ref={(handle) => {
            environmentFilterRef = handle;
          }}
          class="w-44"
          placeholder="Environment…"
          icon={Globe}
          value={tableState.filters().environment}
          onCommit={(v) => tableState.setFilter("environment", v)}
        />
        <DateFilterInput
          class="w-36"
          value={tableState.filters().fromTimestamp}
          onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
          placeholder="From date…"
          title="Score start date"
          boundary="start"
        />
        <DateFilterInput
          class="w-36"
          value={tableState.filters().toTimestamp}
          onCommit={(v) => tableState.setFilter("toTimestamp", v)}
          placeholder="To date…"
          title="Score end date"
          boundary="end"
        />
        <FilterSelect
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
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            nameFilterRef?.commit();
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

      <Show when={!query.isPending} fallback={<TableLoadingRows class="flex-1 px-4" columns={7} />}>
        <Show
          when={!query.isError}
          fallback={
            <div class="px-4 py-3">
              <TableInlineError error={query.error} onRetry={() => void query.refetch()} />
            </div>
          }
        >
          <Show
            when={scores().length > 0}
            fallback={
              <EmptyState
                variant="inline"
                class="mx-4 flex-1"
                title={
                  tableState.activeFilterCount() > 0
                    ? "No scores match the current filters."
                    : "No scores found."
                }
              />
            }
          >
            <div class="flex-1 overflow-auto px-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead class="text-right">Value</TableHead>
                    <TableHead>Data type</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Trace</TableHead>
                    <TableHead>Comment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <For each={scores()}>
                    {(s) => (
                      <TableRow>
                        <TableCell class="max-w-[200px] truncate font-medium">{s.name}</TableCell>
                        <TableCell class="text-right font-mono">{scoreDisplay(s)}</TableCell>
                        <TableCell>
                          <Badge>{s.dataType}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge tone="neutral">{s.source}</Badge>
                        </TableCell>
                        <TableCell class="whitespace-nowrap text-fg-tertiary">
                          {formatDateTime(s.timestamp)}
                        </TableCell>
                        <TableCell class="max-w-[120px]">
                          {s.traceId ? (
                            <A
                              href={`/traces/${encodeURIComponent(s.traceId)}`}
                              class="font-mono text-xs text-brand hover:underline"
                              title={s.traceId}
                            >
                              {s.traceId.slice(0, 8)}…
                            </A>
                          ) : (
                            <span class="text-fg-tertiary">Unlinked</span>
                          )}
                        </TableCell>
                        <TableCell class="max-w-[240px] truncate text-fg-tertiary">
                          {s.comment ?? "—"}
                        </TableCell>
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
