import { Search } from "lucide-react";
import { Link } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { FilterInput } from "@/shared/components/filter-input";
import { LevelBadge, ObservationTypeBadge } from "@/shared/components/observation-badges";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
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
const ALL = "__all__";

type ObservationFilters = { name?: string; type?: string; level?: string };

export function ObservationsPage() {
  const tableState = useTableState<ObservationFilters>({
    filterKeys: ["name", "type", "level"],
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
          className="w-52"
          placeholder="Filter by name…"
          icon={Search}
          value={tableState.filters.name}
          onCommit={(v) => tableState.setFilter("name", v)}
        />
        <Select
          value={tableState.filters.type ?? ALL}
          onValueChange={(v) => tableState.setFilter("type", v !== ALL ? v : undefined)}
        >
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            <SelectItem value="SPAN">SPAN</SelectItem>
            <SelectItem value="GENERATION">GENERATION</SelectItem>
            <SelectItem value="EVENT">EVENT</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={tableState.filters.level ?? ALL}
          onValueChange={(v) => tableState.setFilter("level", v !== ALL ? v : undefined)}
        >
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All levels</SelectItem>
            <SelectItem value="DEBUG">DEBUG</SelectItem>
            <SelectItem value="DEFAULT">DEFAULT</SelectItem>
            <SelectItem value="WARNING">WARNING</SelectItem>
            <SelectItem value="ERROR">ERROR</SelectItem>
          </SelectContent>
        </Select>
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
        <EmptyState message="No observations found." />
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Level</TableHead>
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
