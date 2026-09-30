import { Link } from "react-router-dom";
import { ObservabilityFilterBar } from "@/shared/components/observability-filter-bar";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Badge } from "@/shared/components/ui/badge";
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
import type { Score, ScoreListParams } from "@/shared/lib/types";
import { FILTER_FIELDS, FILTER_KEYS, type ScoreFilters } from "./scores-filters";

const PAGE_SIZE = 25;

function scoreDisplay(s: Score): string {
  if (s.stringValue !== null && s.stringValue !== undefined) return s.stringValue;
  if (s.value !== null && s.value !== undefined) {
    return Number.isInteger(s.value) ? String(s.value) : s.value.toFixed(4);
  }
  return "—";
}

export function ScoresPage() {
  const tableState = useTableState<ScoreFilters>({
    filterKeys: FILTER_KEYS,
    defaultSort: "timestamp.desc",
  });

  const params: ScoreListParams = {
    page: tableState.page,
    limit: PAGE_SIZE,
    ...tableState.filters,
    value: tableState.filters.value ? Number(tableState.filters.value) : undefined,
    operator: tableState.filters.value ? tableState.filters.operator || "=" : undefined,
  };
  const query = useScoresQuery(params);

  const scores: Score[] = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Scores"
        description="Evaluation scores attached to traces and observations."
      />

      <div className="px-6 py-3">
        <ObservabilityFilterBar fields={FILTER_FIELDS} tableState={tableState} />
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
