import { Search } from "lucide-react";
import { Link } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { FilterInput } from "@/shared/components/filter-input";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Badge } from "@/shared/components/ui/badge";
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
import { useScoresQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
import { formatDateTime } from "@/shared/lib/format";
import type { Score } from "@/shared/lib/types";

const PAGE_SIZE = 25;
const ALL = "__all__";

type ScoreFilters = { name?: string; source?: string; dataType?: string };

function scoreDisplay(s: Score): string {
  if (s.stringValue !== null && s.stringValue !== undefined) return s.stringValue;
  if (s.value !== null && s.value !== undefined) {
    return Number.isInteger(s.value) ? String(s.value) : s.value.toFixed(4);
  }
  return "—";
}

export function ScoresPage() {
  const tableState = useTableState<ScoreFilters>({
    filterKeys: ["name", "source", "dataType"],
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
          className="w-52"
          placeholder="Filter by name…"
          icon={Search}
          value={tableState.filters.name}
          onCommit={(v) => tableState.setFilter("name", v)}
        />
        <Select
          value={tableState.filters.source ?? ALL}
          onValueChange={(v) => tableState.setFilter("source", v !== ALL ? v : undefined)}
        >
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            <SelectItem value="API">API</SelectItem>
            <SelectItem value="EVAL">EVAL</SelectItem>
            <SelectItem value="ANNOTATION">ANNOTATION</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={tableState.filters.dataType ?? ALL}
          onValueChange={(v) => tableState.setFilter("dataType", v !== ALL ? v : undefined)}
        >
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Data type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            <SelectItem value="NUMERIC">NUMERIC</SelectItem>
            <SelectItem value="CATEGORICAL">CATEGORICAL</SelectItem>
            <SelectItem value="BOOLEAN">BOOLEAN</SelectItem>
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
      ) : scores.length === 0 ? (
        <EmptyState message="No scores found." />
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
                      <Link
                        to={`/traces/${encodeURIComponent(s.traceId)}`}
                        className="font-mono text-xs text-primary hover:underline"
                        title={s.traceId}
                      >
                        {s.traceId.slice(0, 8)}…
                      </Link>
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
