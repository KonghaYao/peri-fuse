/**
 * Traces table — lite replica of web's traces table use-case
 * (web/src/components/table/use-cases/traces.tsx).
 *
 * Data flow mirrors the original: a "core" list query provides the row
 * identities, then a per-page metrics query (GET /api/public/traces/metrics)
 * supplies IO/latency/tokens/cost/levels which are joined client-side by id
 * (the original's joinTableCoreAndMetrics pattern). Metrics cells render
 * skeletons until the metrics query resolves.
 *
 * Server-side sorting is supported for core trace columns only; metrics
 * columns are not sortable in lite v1 (would require JOINing the list query).
 */

import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DataTable } from "@/components/data-table";
import { IoCell } from "@/components/io-cell";
import {
  formatAsLabel,
  LevelColors,
  LevelSymbols,
  type ObservationLevelType,
} from "@/components/level-colors";
import { type LevelCount, LevelCountsDisplay } from "@/components/level-counts-display";
import { LocalIsoDate } from "@/components/local-iso-date";
import { PageHeader } from "@/components/state";
import TableIdOrName from "@/components/table-id";
import { TokenUsageBadge } from "@/components/token-usage-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getTracesMetrics, listTraces } from "@/lib/api";
import { formatIntervalSeconds, numberFormatter, usdFormatter } from "@/lib/format";
import type { Trace, TraceMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
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
      inputCost: m?.calculatedInputCost ?? null,
      outputCost: m?.calculatedOutputCost ?? null,
      totalCost: m?.calculatedTotalCost ?? null,
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
        <span className="text-nowrap">{formatIntervalSeconds(value)}</span>
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
    accessorKey: "totalCost",
    id: "totalCost",
    header: "Total Cost",
    enableSorting: false,
    cell: ({ row }) => {
      const cost = row.original.totalCost;
      if (row.original.levelCounts === null && cost === null)
        return <Skeleton className="h-4 w-14" />;
      return cost != null && cost > 0 ? <span>{usdFormatter(cost)}</span> : <span>-</span>;
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
    id: "cost",
    header: "Cost",
    meta: { defaultHidden: true },
    enableSorting: false,
    columns: [
      {
        accessorKey: "inputCost",
        id: "inputCost",
        header: "Input Cost",
        meta: { defaultHidden: true },
        enableSorting: false,
        cell: ({ row }) => {
          const cost = row.original.inputCost;
          if (row.original.levelCounts === null && cost === null)
            return <Skeleton className="h-4 w-12" />;
          return cost ? <span>{usdFormatter(cost)}</span> : <span>-</span>;
        },
      },
      {
        accessorKey: "outputCost",
        id: "outputCost",
        header: "Output Cost",
        meta: { defaultHidden: true },
        enableSorting: false,
        cell: ({ row }) => {
          const cost = row.original.outputCost;
          if (row.original.levelCounts === null && cost === null)
            return <Skeleton className="h-4 w-12" />;
          return cost ? <span>{usdFormatter(cost)}</span> : <span>-</span>;
        },
      },
    ],
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
    ],
  },
];

type Filters = {
  name?: string;
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

export function TracesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: "timestamp", desc: true }]);

  // Committed filters (applied on Enter / search click).
  const [nameInput, setNameInput] = useState("");
  const [userIdInput, setUserIdInput] = useState("");
  const [environmentInput, setEnvironmentInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [filters, setFilters] = useState<Filters>({});

  const orderBy =
    sorting.length > 0
      ? `${sorting[0]?.id}.${sorting[0]?.desc ? "desc" : "asc"}`
      : "timestamp.desc";

  const coreQuery = useQuery({
    queryKey: ["traces", page, filters, orderBy],
    queryFn: () =>
      listTraces({
        page,
        limit: PAGE_SIZE,
        orderBy,
        ...filters,
      }),
  });

  const traceIds = useMemo(() => (coreQuery.data?.data ?? []).map((t) => t.id), [coreQuery.data]);

  const metricsQuery = useQuery({
    queryKey: ["traces-metrics", traceIds.join(",")],
    queryFn: () => getTracesMetrics(traceIds),
    enabled: traceIds.length > 0,
  });

  const rows = useMemo(
    () => joinCoreAndMetrics(coreQuery.data?.data ?? [], metricsQuery.data),
    [coreQuery.data, metricsQuery.data],
  );

  const applyFilters = () => {
    setPage(1);
    setFilters({
      name: nameInput.trim() || undefined,
      userId: userIdInput.trim() || undefined,
      environment: environmentInput.trim() || undefined,
      fromTimestamp: fromInput ? new Date(fromInput).toISOString() : undefined,
      toTimestamp: toInput ? new Date(toInput).toISOString() : undefined,
    });
  };

  const handleSortingChange = (next: SortingState) => {
    setPage(1);
    setSorting(next);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Traces" description="All traces ingested into this lite project." />

      <div className="flex-1 overflow-auto px-4 py-3">
        <DataTable
          columns={columns}
          data={rows}
          isLoading={coreQuery.isLoading}
          error={coreQuery.error ?? metricsQuery.error}
          emptyMessage="No traces found."
          meta={coreQuery.data?.meta}
          page={page}
          onPageChange={setPage}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          getRowId={(row) => row.id}
          onRowClick={(row) => navigate(`/traces/${encodeURIComponent(row.id)}`)}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-44"
                placeholder="Filter by name…"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
              <Input
                className="h-8 w-44"
                placeholder="Filter by userId…"
                value={userIdInput}
                onChange={(e) => setUserIdInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
              <Input
                className="h-8 w-44"
                placeholder="Filter by environment…"
                value={environmentInput}
                onChange={(e) => setEnvironmentInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
              <Input
                type="datetime-local"
                className="h-8 w-52"
                title="From timestamp"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
              />
              <Input
                type="datetime-local"
                className="h-8 w-52"
                title="To timestamp"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
              />
              <Button size="sm" variant="outline" onClick={applyFilters}>
                <Search className="h-4 w-4" />
                Search
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
