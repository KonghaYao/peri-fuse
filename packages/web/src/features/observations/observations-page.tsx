import {
  Button,
  DateFilterInput,
  EmptyState,
  FilterInput,
  type FilterInputHandle,
  FilterSelect,
  MonitorObservationLevelBadge,
  MonitorObservationTypeBadge,
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
import { useObservationsQuery } from "@/shared/hooks/queries";
import { formatDateTime, formatTokens } from "@/shared/lib/format";
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

  const query = useObservationsQuery({
    page: tableState.page(),
    limit: PAGE_SIZE,
    ...tableState.filters(),
  });

  const observations = () => (query.data?.data ?? []) as Observation[];

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Observations"
        description="Spans, generations and events across all traces."
      />

      <div class="flex flex-wrap items-center gap-8 px-24 py-12">
        <FilterInput
          ref={(handle) => {
            nameFilterRef = handle;
          }}
          class="w-208"
          placeholder="Filter by name…"
          icon={Search}
          value={tableState.filters().name}
          onCommit={(v) => tableState.setFilter("name", v)}
        />
        <FilterSelect
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
        <FilterInput
          ref={(handle) => {
            environmentFilterRef = handle;
          }}
          class="w-176"
          placeholder="Environment…"
          icon={Globe}
          value={tableState.filters().environment}
          onCommit={(v) => tableState.setFilter("environment", v)}
        />
        <DateFilterInput
          class="w-144"
          value={tableState.filters().fromStartTime}
          onCommit={(v) => tableState.setFilter("fromStartTime", v)}
          placeholder="From date…"
          title="Observation start date"
          boundary="start"
        />
        <DateFilterInput
          class="w-144"
          value={tableState.filters().toStartTime}
          onCommit={(v) => tableState.setFilter("toStartTime", v)}
          placeholder="To date…"
          title="Observation end date"
          boundary="end"
        />
        <FilterSelect
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
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            nameFilterRef?.commit();
            environmentFilterRef?.commit();
          }}
        >
          <Search class="h-16 w-16" size={16} />
          Search
        </Button>
        <Show when={tableState.activeFilterCount() > 0}>
          <Button size="sm" variant="ghost" onClick={tableState.clearFilters}>
            <Search class="h-16 w-16" size={16} />
            Clear ({tableState.activeFilterCount()})
          </Button>
        </Show>
        <div class="ml-auto">
          <AutoRefreshControl />
        </div>
      </div>

      <Show when={!query.isPending} fallback={<TableLoadingRows class="flex-1 px-16" columns={8} />}>
        <Show
          when={!query.isError}
          fallback={
            <div class="px-16 py-12">
              <TableInlineError error={query.error} onRetry={() => void query.refetch()} />
            </div>
          }
        >
          <Show
            when={observations().length > 0}
            fallback={
              <EmptyState
                variant="inline"
                class="mx-16 flex-1"
                title={
                  tableState.activeFilterCount() > 0
                    ? "No observations match the current filters."
                    : "No observations found."
                }
              />
            }
          >
            <div class="flex-1 overflow-auto px-16">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead>Start time</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead class="text-right">Tokens</TableHead>
                    <TableHead>Trace</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <For each={observations()}>
                    {(o) => (
                      <TableRow>
                        <TableCell class="max-w-[220px] truncate font-medium">
                          {o.name ?? <span class="text-fg-tertiary">(unnamed)</span>}
                        </TableCell>
                        <TableCell>
                          <MonitorObservationTypeBadge type={o.type} />
                        </TableCell>
                        <TableCell>
                          <MonitorObservationLevelBadge level={o.level} />
                        </TableCell>
                        <TableCell class="max-w-[360px] text-fg-tertiary">
                          {o.level === "ERROR" ? (
                            <span
                              class="block truncate text-danger"
                              title={o.statusMessage || "No status message recorded"}
                            >
                              {o.statusMessage || "No status message recorded"}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell class="whitespace-nowrap text-fg-tertiary">
                          {formatDateTime(o.startTime)}
                        </TableCell>
                        <TableCell class="max-w-[140px] truncate text-fg-tertiary">
                          {o.model ?? "—"}
                        </TableCell>
                        <TableCell class="text-right text-fg-tertiary">
                          {o.totalTokens > 0 ? formatTokens(o.totalTokens) : "—"}
                        </TableCell>
                        <TableCell class="max-w-[120px]">
                          {o.traceId ? (
                            <A
                              href={`/traces/${encodeURIComponent(o.traceId)}`}
                              class="truncate font-mono text-xs text-brand hover:underline"
                              title={o.traceId}
                            >
                              {o.traceId.slice(0, 8)}…
                            </A>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </For>
                </TableBody>
              </Table>
            </div>
            <div class="border-t border-border px-16 py-8">
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
