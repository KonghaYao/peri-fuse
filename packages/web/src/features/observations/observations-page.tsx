import { Link } from "react-router-dom";
import { ObservabilityFilterBar } from "@/shared/components/observability-filter-bar";
import { LevelBadge, ObservationTypeBadge } from "@/shared/components/observation-badges";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
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
import { FILTER_FIELDS, FILTER_KEYS, type ObservationFilters } from "./observations-filters";

const PAGE_SIZE = 25;

export function ObservationsPage() {
  const tableState = useTableState<ObservationFilters>({
    filterKeys: FILTER_KEYS,
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
      <PageHeader title="Observations" description="All observation types across all traces." />

      <div className="px-6 py-3">
        <ObservabilityFilterBar fields={FILTER_FIELDS} tableState={tableState} />
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
