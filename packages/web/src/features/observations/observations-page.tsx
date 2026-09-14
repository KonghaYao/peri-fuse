import { Globe, Search } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { DateFilterInput } from "@/shared/components/date-filter-input";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { FilterSelect } from "@/shared/components/filter-select";
import { LevelBadge, ObservationTypeBadge } from "@/shared/components/observation-badges";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { useObservationsQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
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

export function ObservationsPage() {
  const nameFilterRef = useRef<FilterInputHandle>(null);
  const environmentFilterRef = useRef<FilterInputHandle>(null);

  const tableState = useTableState<ObservationFilters>({
    filterKeys: ["name", "type", "level", "environment", "fromStartTime", "toStartTime"],
    defaultSort: "startTime.desc",
  });

  const query = useObservationsQuery({
    page: tableState.page,
    limit: PAGE_SIZE,
    ...tableState.filters,
  });

  const observations: Observation[] = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Observations"
        description="Spans, generations and events across all traces."
      />

      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <FilterInput
          ref={nameFilterRef}
          className="w-52"
          placeholder="Filter by name…"
          icon={Search}
          value={tableState.filters.name}
          onCommit={(v) => tableState.setFilter("name", v)}
        />
        <FilterSelect
          placeholder="Type"
          allLabel="All types"
          value={tableState.filters.type}
          onCommit={(v) => tableState.setFilter("type", v)}
          options={[
            { value: "SPAN", label: "SPAN" },
            { value: "GENERATION", label: "GENERATION" },
            { value: "EVENT", label: "EVENT" },
          ]}
        />
        <FilterInput
          ref={environmentFilterRef}
          className="w-44"
          placeholder="Environment…"
          icon={Globe}
          value={tableState.filters.environment}
          onCommit={(v) => tableState.setFilter("environment", v)}
        />
        <DateFilterInput
          className="w-36"
          value={tableState.filters.fromStartTime}
          onCommit={(v) => tableState.setFilter("fromStartTime", v)}
          placeholder="From date…"
          title="Observation start date"
          boundary="start"
        />
        <DateFilterInput
          className="w-36"
          value={tableState.filters.toStartTime}
          onCommit={(v) => tableState.setFilter("toStartTime", v)}
          placeholder="To date…"
          title="Observation end date"
          boundary="end"
        />
        <FilterSelect
          placeholder="Level"
          allLabel="All levels"
          value={tableState.filters.level}
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
            nameFilterRef.current?.commit();
            environmentFilterRef.current?.commit();
          }}
        >
          <Search className="h-4 w-4" />
          Search
        </Button>
        {tableState.activeFilterCount > 0 && (
          <Button size="sm" variant="ghost" onClick={tableState.clearFilters}>
            <Search className="h-4 w-4" />
            Clear ({tableState.activeFilterCount})
          </Button>
        )}
        <div className="ml-auto">
          <AutoRefreshControl />
        </div>
      </div>

      {query.isLoading ? (
        <LoadingRows />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : observations.length === 0 ? (
        <EmptyState
          message={
            tableState.activeFilterCount > 0
              ? "No observations match the current filters."
              : "No observations found."
          }
        />
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Start time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {observations.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="max-w-[220px] truncate font-medium">
                      {o.name ?? <span className="text-muted-foreground">(unnamed)</span>}
                    </TableCell>
                    <TableCell>
                      <ObservationTypeBadge type={o.type} />
                    </TableCell>
                    <TableCell>
                      <LevelBadge level={o.level} />
                    </TableCell>
                    <TableCell className="max-w-[360px] text-muted-foreground">
                      {o.level === "ERROR" ? (
                        <span
                          className="block truncate text-danger"
                          title={o.statusMessage || "No status message recorded"}
                        >
                          {o.statusMessage || "No status message recorded"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(o.startTime)}
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate text-muted-foreground">
                      {o.model ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {o.totalTokens > 0 ? formatTokens(o.totalTokens) : "—"}
                    </TableCell>
                    <TableCell className="max-w-[120px]">
                      {o.traceId ? (
                        <Link
                          to={`/traces/${encodeURIComponent(o.traceId)}`}
                          className="truncate font-mono text-xs text-primary hover:underline"
                          title={o.traceId}
                        >
                          {o.traceId.slice(0, 8)}…
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-border px-4 py-2">
            <Pagination
              meta={query.data?.meta}
              page={tableState.page}
              pageSize={PAGE_SIZE}
              onPageChange={tableState.setPage}
            />
          </div>
        </>
      )}
    </div>
  );
}
