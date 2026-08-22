import { Globe, Search } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { DateFilterInput } from "@/shared/components/date-filter-input";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { FilterSelect } from "@/shared/components/filter-select";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { useScoresQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
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

export function ScoresPage() {
  const nameFilterRef = useRef<FilterInputHandle>(null);
  const environmentFilterRef = useRef<FilterInputHandle>(null);

  const tableState = useTableState<ScoreFilters>({
    filterKeys: ["name", "source", "dataType", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "timestamp.desc",
  });

  const query = useScoresQuery({
    page: tableState.page,
    limit: PAGE_SIZE,
    ...tableState.filters,
  });

  const scores: Score[] = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Scores"
        description="Evaluation scores attached to traces and observations."
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
          placeholder="Source"
          allLabel="All sources"
          value={tableState.filters.source}
          onCommit={(v) => tableState.setFilter("source", v)}
          options={[
            { value: "API", label: "API" },
            { value: "EVAL", label: "EVAL" },
            { value: "ANNOTATION", label: "ANNOTATION" },
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
          value={tableState.filters.fromTimestamp}
          onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
          placeholder="From date…"
          title="Score start date"
          boundary="start"
        />
        <DateFilterInput
          className="w-36"
          value={tableState.filters.toTimestamp}
          onCommit={(v) => tableState.setFilter("toTimestamp", v)}
          placeholder="To date…"
          title="Score end date"
          boundary="end"
        />
        <FilterSelect
          placeholder="Data type"
          allLabel="All types"
          value={tableState.filters.dataType}
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
      ) : scores.length === 0 ? (
        <EmptyState
          message={
            tableState.activeFilterCount > 0
              ? "No scores match the current filters."
              : "No scores found."
          }
        />
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Data type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Trace</TableHead>
                  <TableHead>Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scores.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-[200px] truncate font-medium">{s.name}</TableCell>
                    <TableCell className="text-right font-mono">{scoreDisplay(s)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.dataType}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="muted">{s.source}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(s.timestamp)}
                    </TableCell>
                    <TableCell className="max-w-[120px]">
                      {s.traceId ? (
                        <Link
                          to={`/traces/${encodeURIComponent(s.traceId)}`}
                          className="font-mono text-xs text-primary hover:underline"
                          title={s.traceId}
                        >
                          {s.traceId.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Unlinked</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-muted-foreground">
                      {s.comment ?? "—"}
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
