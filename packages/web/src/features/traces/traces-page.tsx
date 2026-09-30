/**
 * Traces table — lite replica of web's traces table use-case.
 *
 * Data flow: a "core" list query provides the row identities, then a per-page
 * metrics query (GET /api/public/traces/metrics) supplies bounded IO previews,
 * latency, tokens, and levels which are joined client-side by id
 * (joinTableCoreAndMetrics).
 * Metrics cells render skeletons until the metrics query resolves.
 *
 * State is URL-synced via useTableState (page, sort, filters in searchParams).
 */

import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { TracePeekView } from "@/features/traces/trace-peek-view";
import { columns, joinCoreAndMetrics } from "@/features/traces/traces-table";
import { DataTable } from "@/shared/components/data-table";
import { ObservabilityFilterBar } from "@/shared/components/observability-filter-bar";
import { PageHeader } from "@/shared/components/state";
import { useTracesMetricsQuery, useTracesQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
import { FILTER_FIELDS, FILTER_KEYS, type TraceFilters } from "./traces-filters";

const PAGE_SIZE = 50;

export function TracesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const peekedTraceId = searchParams.get("peek");

  const tableState = useTableState<TraceFilters>({
    filterKeys: FILTER_KEYS,
    defaultSort: "timestamp.desc",
  });

  /** Open/close the peek panel by syncing the `peek` URL param. */
  const setPeek = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) {
            next.set("peek", id);
          } else {
            next.delete("peek");
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const coreQuery = useTracesQuery({
    page: tableState.page,
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy,
    ...tableState.filters,
  });

  const traceIds = useMemo(() => (coreQuery.data?.data ?? []).map((t) => t.id), [coreQuery.data]);

  const metricsQuery = useTracesMetricsQuery(traceIds);

  const rows = useMemo(
    () => joinCoreAndMetrics(coreQuery.data?.data ?? [], metricsQuery.data),
    [coreQuery.data, metricsQuery.data],
  );

  // Keyboard navigation — j/k moves the peek selection through the current
  // page, Esc closes the panel. Ignored while typing in form controls.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "j" || e.key === "k") {
        const ids = rows.map((r) => r.id);
        if (ids.length === 0) return;
        e.preventDefault();
        const idx = peekedTraceId ? ids.indexOf(peekedTraceId) : -1;
        const next =
          e.key === "j" ? Math.min(idx + 1, ids.length - 1) : Math.max(idx <= 0 ? 0 : idx - 1, 0);
        setPeek(ids[next]);
      } else if (e.key === "Escape" && peekedTraceId) {
        setPeek(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [rows, peekedTraceId, setPeek]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Traces" description="All traces ingested into this lite project." />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-4 py-3">
          <DataTable
            columns={columns}
            data={rows}
            isLoading={coreQuery.isLoading}
            error={coreQuery.error ?? metricsQuery.error}
            emptyMessage="No traces found."
            meta={coreQuery.data?.meta}
            page={tableState.page}
            pageSize={PAGE_SIZE}
            onPageChange={tableState.setPage}
            sorting={tableState.sorting}
            onSortingChange={tableState.setSorting}
            getRowId={(row) => row.id}
            selectedRowId={peekedTraceId}
            onRowClick={(row) => setPeek(row.id)}
            toolbar={<ObservabilityFilterBar fields={FILTER_FIELDS} tableState={tableState} />}
          />
        </div>

        {peekedTraceId && <TracePeekView traceId={peekedTraceId} onClose={() => setPeek(null)} />}
      </div>
    </div>
  );
}
