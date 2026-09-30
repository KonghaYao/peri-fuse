import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router-dom";
import { IoCell } from "@/shared/components/io-cell";
import {
  formatAsLabel,
  LevelColors,
  LevelSymbols,
  type ObservationLevelType,
} from "@/shared/components/level-colors";
import { type LevelCount, LevelCountsDisplay } from "@/shared/components/level-counts-display";
import { LocalIsoDate } from "@/shared/components/local-iso-date";
import TableIdOrName from "@/shared/components/table-id";
import { TokenUsageBadge } from "@/shared/components/token-usage-badge";
import { Badge } from "@/shared/components/ui/badge";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { formatIntervalSeconds, formatPercent, numberFormatter } from "@/shared/lib/format";
import type { Trace, TraceMetrics } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

type LevelCounts = {
  errorCount: number;
  warningCount: number;
  debugCount: number;
  defaultCount: number;
};

export type TracesTableRow = {
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
export function joinCoreAndMetrics(
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

export const columns: ColumnDef<TracesTableRow, unknown>[] = [
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
    meta: { defaultHidden: true },
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
    meta: { defaultHidden: true },
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
    meta: { defaultHidden: true },
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
    meta: { defaultHidden: true },
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
        meta: { defaultHidden: true },
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
        meta: { defaultHidden: true },
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
