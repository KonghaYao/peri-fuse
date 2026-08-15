/**
 * Traces table — lite replica of web's traces table use-case.
 *
 * Data flow: a "core" list query provides the row identities, then a per-page
 * metrics query (GET /api/public/traces/metrics) supplies IO/latency/tokens/
 * levels which are joined client-side by id (joinTableCoreAndMetrics).
 * Metrics cells render skeletons until the metrics query resolves.
 *
 * State is URL-synced via useTableState (page, sort, filters in searchParams).
 */

import type { ColumnDef } from "@tanstack/react-table";
import { Globe, Search, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TracePeekView } from "@/features/traces/trace-peek-view";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { DataTable } from "@/shared/components/data-table";
import { DateFilterInput } from "@/shared/components/date-filter-input";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { IoCell } from "@/shared/components/io-cell";
import {
  formatAsLabel,
  LevelColors,
  LevelSymbols,
  type ObservationLevelType,
} from "@/shared/components/level-colors";
import { type LevelCount, LevelCountsDisplay } from "@/shared/components/level-counts-display";
import { LocalIsoDate } from "@/shared/components/local-iso-date";
import { PageHeader } from "@/shared/components/state";
import TableIdOrName from "@/shared/components/table-id";
import { TokenUsageBadge } from "@/shared/components/token-usage-badge";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { useTracesMetricsQuery, useTracesQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
import { formatIntervalSeconds, formatPercent, numberFormatter } from "@/shared/lib/format";
import type { Trace, TraceMetrics } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

const PAGE_SIZE = 50;

type LevelCounts = {
  errorCount: number;
  warningCount: number;
  debugCount: number;
  defaultCount: number;
};

type TracesTableRow = {
  id: string;
  timestamp: string;
  name: string | null;
  userId: string | null;
  sessionId: string | null;
  release: string | null;
  version: string | null;
  environment: string | null;
  tags: string[];
  // Joined from the metrics endpoint (null until loaded):
  input: unknown;
  output: unknown;
  metadata: unknown;
  latency: number | null;
  observationCount: number | null;
  level: string | null;
  levelCounts: LevelCounts | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheHitRate: number | null;
};

/** Client-side join of core trace rows and per-trace metrics (by id). */
function joinCoreAndMetrics(
  traces: Trace[],
  metrics: TraceMetrics[] | undefined,
): TracesTableRow[] {
  const byId = new Map((metrics ?? []).map((m) => [m.id, m]));
  return traces.map((t) => {
    const m = byId.get(t.id);
    return {
      id: t.id,
      timestamp: t.timestamp,
      name: t.name,
      userId: t.userId,
      sessionId: t.sessionId,
      release: t.release,
      version: t.version,
      environment: t.environment ?? null,
      tags: t.tags,
      input: m?.input ?? null,
      output: m?.output ?? null,
      metadata: m?.metadata ?? null,
      latency: m?.latency ?? null,
      observationCount: m?.observationCount ?? null,
      level: m?.level ?? null,
      levelCounts: m
        ? {
            errorCount: m.errorCount,
            warningCount: m.warningCount,
            debugCount: m.debugCount,
            defaultCount: m.defaultCount,
          }
        : null,
      promptTokens: m?.promptTokens ?? null,
      completionTokens: m?.completionTokens ?? null,
      totalTokens: m?.totalTokens ?? null,
      cachedTokens: m?.cachedTokens ?? null,
      cacheHitRate: m?.cacheHitRate ?? null,
    };
  });
}

const columns: ColumnDef<TracesTableRow, unknown>[] = [
  {
    accessorKey: "timestamp",
    header: "Timestamp",
    id: "timestamp",
    cell: ({ row }) => {
      const value = row.original.timestamp;
      return value ? <LocalIsoDate date={new Date(value)} /> : undefined;
    },
  },
  {
    accessorKey: "name",
    header: "Name",
    id: "name",
    cell: ({ row }) => row.original.name ?? undefined,
  },
  {
    accessorKey: "input",
    header: "Input",
    id: "input",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.levelCounts === null && row.original.input === null ? (
        <Skeleton className="h-4 w-3/4" />
      ) : (
        <IoCell io={row.original.input} variant="input" />
      ),
  },
  {
    accessorKey: "output",
    header: "Output",
    id: "output",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.levelCounts === null && row.original.output === null ? (
        <Skeleton className="h-4 w-3/4" />
      ) : (
        <IoCell io={row.original.output} variant="output" />
      ),
  },
  {
    accessorKey: "levelCounts",
    id: "levelCounts",
    header: "Observation Levels",
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.levelCounts;
      if (!value) return <Skeleton className="h-4 w-1/2" />;
      const counts: LevelCount[] = Object.entries(value).map(([level, count]) => ({
        level: formatAsLabel(level),
        count,
        symbol: LevelSymbols[formatAsLabel(level)],
      }));
      return <LevelCountsDisplay counts={counts} />;
    },
  },
  {
    accessorKey: "latency",
    id: "latency",
    header: "Latency",
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.latency;
      if (row.original.levelCounts === null && value === null)
        return <Skeleton className="h-4 w-12" />;
      return value !== null && value !== undefined ? (
        <span className="tnum text-nowrap font-mono text-[12.5px]">
          {formatIntervalSeconds(value)}
        </span>
      ) : undefined;
    },
  },
  {
    id: "tokens",
    header: "Tokens",
    accessorFn: (row) => row.totalTokens,
    enableSorting: false,
    cell: ({ row }) => {
      const { promptTokens, completionTokens, totalTokens } = row.original;
      if (promptTokens === null || completionTokens === null)
        return <Skeleton className="h-4 w-16" />;
      return (
        <TokenUsageBadge
          inputUsage={promptTokens}
          outputUsage={completionTokens}
          totalUsage={totalTokens ?? 0}
          inline
        />
      );
    },
  },
  {
    accessorKey: "environment",
    header: "Environment",
    id: "environment",
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.environment;
      return value ? (
        <Badge
          variant="secondary"
          className="max-w-fit truncate rounded-sm px-1 font-normal"
          title={value}
        >
          {value}
        </Badge>
      ) : null;
    },
  },
  {
    accessorKey: "tags",
    id: "tags",
    header: "Tags",
    enableSorting: false,
    cell: ({ row }) => {
      const traceTags = row.original.tags;
      return (
        traceTags &&
        traceTags.length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {traceTags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="secondary" className="font-normal">
                {tag}
              </Badge>
            ))}
            {traceTags.length > 4 && <Badge variant="outline">+{traceTags.length - 4}</Badge>}
          </div>
        )
      );
    },
  },
  {
    accessorKey: "metadata",
    header: "Metadata",
    id: "metadata",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.levelCounts === null && row.original.metadata === null ? (
        <Skeleton className="h-4 w-3/4" />
      ) : (
        <IoCell io={row.original.metadata} />
      ),
  },
  {
    accessorKey: "sessionId",
    id: "sessionId",
    header: "Session",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.sessionId;
      return value && typeof value === "string" ? (
        <Link
          to={`/sessions/${encodeURIComponent(value)}`}
          onClick={(e) => e.stopPropagation()}
          className="text-primary hover:underline"
        >
          <TableIdOrName value={value} />
        </Link>
      ) : undefined;
    },
  },
  {
    accessorKey: "userId",
    header: "User",
    id: "userId",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.userId;
      return value && typeof value === "string" ? <TableIdOrName value={value} /> : undefined;
    },
  },
  {
    accessorKey: "observationCount",
    id: "observationCount",
    header: "Observations",
    meta: { defaultHidden: true },
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.observationCount;
      if (value === null) return <Skeleton className="h-4 w-8" />;
      return <span>{numberFormatter(value, 0)}</span>;
    },
  },
  {
    accessorKey: "level",
    id: "level",
    header: "Level",
    meta: { defaultHidden: true },
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.level;
      if (value === null) return <Skeleton className="h-4 w-10" />;
      return value ? (
        <span
          className={cn(
            "rounded-sm p-0.5 text-xs",
            LevelColors[value as ObservationLevelType]?.bg,
            LevelColors[value as ObservationLevelType]?.text,
          )}
        >
          {value}
        </span>
      ) : (
        <span>-</span>
      );
    },
  },
  {
    accessorKey: "version",
    id: "version",
    header: "Version",
    meta: { defaultHidden: true },
  },
  {
    accessorKey: "release",
    id: "release",
    header: "Release",
    meta: { defaultHidden: true },
  },
  {
    accessorKey: "id",
    header: "Trace ID",
    id: "traceId",
    meta: { defaultHidden: true },
    cell: ({ row }) => <TableIdOrName value={row.original.id} />,
  },
  {
    id: "usage",
    header: "Usage",
    meta: { defaultHidden: true },
    enableSorting: false,
    columns: [
      {
        accessorKey: "inputTokens",
        id: "inputTokens",
        header: "Input Tokens",
        accessorFn: (row) => row.promptTokens,
        meta: { defaultHidden: true },
        enableSorting: false,
        cell: ({ row }) => {
          const value = row.original.promptTokens;
          if (value === null) return <Skeleton className="h-4 w-10" />;
          return <span>{numberFormatter(value, 0)}</span>;
        },
      },
      {
        accessorKey: "outputTokens",
        id: "outputTokens",
        header: "Output Tokens",
        accessorFn: (row) => row.completionTokens,
        meta: { defaultHidden: true },
        enableSorting: false,
        cell: ({ row }) => {
          const value = row.original.completionTokens;
          if (value === null) return <Skeleton className="h-4 w-10" />;
          return <span>{numberFormatter(value, 0)}</span>;
        },
      },
      {
        accessorKey: "totalTokens",
        id: "totalTokens",
        header: "Total Tokens",
        accessorFn: (row) => row.totalTokens,
        meta: { defaultHidden: true },
        enableSorting: false,
        cell: ({ row }) => {
          const value = row.original.totalTokens;
          if (value === null) return <Skeleton className="h-4 w-10" />;
          return <span>{numberFormatter(value, 0)}</span>;
        },
      },
      {
        accessorKey: "cachedTokens",
        id: "cachedTokens",
        header: "Cached Tokens",
        accessorFn: (row) => row.cachedTokens,
        enableSorting: false,
        cell: ({ row }) => {
          const value = row.original.cachedTokens;
          if (value === null) return <Skeleton className="h-4 w-10" />;
          return <span>{numberFormatter(value, 0)}</span>;
        },
      },
      {
        accessorKey: "cacheHitRate",
        id: "cacheHitRate",
        header: "Cache Hit Rate",
        accessorFn: (row) => row.cacheHitRate,
        enableSorting: false,
        cell: ({ row }) => {
          const value = row.original.cacheHitRate;
          if (value === null) return <Skeleton className="h-4 w-10" />;
          return <span>{formatPercent(value)}</span>;
        },
      },
    ],
  },
];

type TraceFilters = {
  name?: string;
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

export function TracesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const peekedTraceId = searchParams.get("peek");
  const nameFilterRef = useRef<FilterInputHandle>(null);
  const userIdFilterRef = useRef<FilterInputHandle>(null);
  const environmentFilterRef = useRef<FilterInputHandle>(null);

  const tableState = useTableState<TraceFilters>({
    filterKeys: ["name", "userId", "environment", "fromTimestamp", "toTimestamp"],
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
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <FilterInput
                  ref={nameFilterRef}
                  className="w-44"
                  placeholder="Filter by name…"
                  icon={Search}
                  value={tableState.filters.name}
                  onCommit={(v) => tableState.setFilter("name", v)}
                />
                <FilterInput
                  ref={userIdFilterRef}
                  className="w-44"
                  placeholder="Filter by userId…"
                  icon={User}
                  value={tableState.filters.userId}
                  onCommit={(v) => tableState.setFilter("userId", v)}
                />
                <FilterInput
                  ref={environmentFilterRef}
                  className="w-44"
                  placeholder="Filter by environment…"
                  icon={Globe}
                  value={tableState.filters.environment}
                  onCommit={(v) => tableState.setFilter("environment", v)}
                />
                <DateFilterInput
                  className="w-44"
                  title="From timestamp"
                  boundary="start"
                  placeholder="From date"
                  value={tableState.filters.fromTimestamp}
                  onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
                />
                <DateFilterInput
                  className="w-44"
                  title="To timestamp"
                  boundary="end"
                  placeholder="To date"
                  value={tableState.filters.toTimestamp}
                  onCommit={(v) => tableState.setFilter("toTimestamp", v)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    nameFilterRef.current?.commit();
                    userIdFilterRef.current?.commit();
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
            }
          />
        </div>

        {peekedTraceId && <TracePeekView traceId={peekedTraceId} onClose={() => setPeek(null)} />}
      </div>
    </div>
  );
}
