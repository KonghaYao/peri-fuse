/**
 * Sessions table — lite replica of web's sessions table use-case.
 *
 * Sessions are derived server-side from `traces.session_id` (lite mode has no
 * dedicated sessions store). State is URL-synced via useTableState.
 */

import type { ColumnDef } from "@tanstack/react-table";
import { Globe, Search, User } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { DataTable } from "@/shared/components/data-table";
import { FilterInput } from "@/shared/components/filter-input";
import { LocalIsoDate } from "@/shared/components/local-iso-date";
import { PageHeader } from "@/shared/components/state";
import TableIdOrName from "@/shared/components/table-id";
import { TokenUsageBadge } from "@/shared/components/token-usage-badge";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { useSessionsQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
import { formatIntervalSeconds, numberFormatter, usdFormatter } from "@/shared/lib/format";
import type { SessionRow } from "@/shared/lib/types";

const PAGE_SIZE = 50;

type SessionsTableRow = {
  id: string;
  createdAt: string;
  countTraces: number;
  sessionDuration: number | null;
  userIds: string[];
  traceTags: string[];
  environment: string;
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

function toRow(s: SessionRow): SessionsTableRow {
  return {
    id: s.id,
    createdAt: s.createdAt,
    countTraces: s.countTraces,
    sessionDuration: s.sessionDuration,
    userIds: s.userIds,
    traceTags: s.traceTags,
    environment: s.environment,
    inputCost: s.inputCost,
    outputCost: s.outputCost,
    totalCost: s.totalCost,
    inputTokens: s.promptTokens,
    outputTokens: s.completionTokens,
    totalTokens: s.totalTokens,
  };
}

const columns: ColumnDef<SessionsTableRow, unknown>[] = [
  {
    accessorKey: "id",
    id: "id",
    header: "ID",
    cell: ({ row }) => {
      const value = row.original.id;
      return value ? (
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
    accessorKey: "createdAt",
    id: "createdAt",
    header: "Created At",
    cell: ({ row }) => {
      const value = row.original.createdAt;
      return value ? <LocalIsoDate date={new Date(value)} /> : undefined;
    },
  },
  {
    accessorKey: "sessionDuration",
    id: "sessionDuration",
    header: "Duration",
    cell: ({ row }) => {
      const value = row.original.sessionDuration;
      return value !== null && value !== undefined ? formatIntervalSeconds(value) : undefined;
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
    accessorKey: "userIds",
    id: "userIds",
    header: "User IDs",
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.userIds;
      return value && value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((user) => (
            <TableIdOrName key={user} value={user} />
          ))}
        </div>
      ) : undefined;
    },
  },
  {
    accessorKey: "countTraces",
    id: "countTraces",
    header: "Traces",
    cell: ({ row }) => {
      const value = row.original.countTraces;
      return value ? <span>{numberFormatter(value, 0)}</span> : undefined;
    },
  },
  {
    accessorKey: "inputCost",
    id: "inputCost",
    header: "Input Cost",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.inputCost;
      return value ? <span>{usdFormatter(value)}</span> : undefined;
    },
  },
  {
    accessorKey: "outputCost",
    id: "outputCost",
    header: "Output Cost",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.outputCost;
      return value ? <span>{usdFormatter(value)}</span> : undefined;
    },
  },
  {
    accessorKey: "totalCost",
    id: "totalCost",
    header: "Total Cost",
    cell: ({ row }) => {
      const value = row.original.totalCost;
      return value ? <span>{usdFormatter(value)}</span> : undefined;
    },
  },
  {
    accessorKey: "inputTokens",
    id: "inputTokens",
    header: "Input Tokens",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.inputTokens;
      return value ? <span>{numberFormatter(value, 0)}</span> : undefined;
    },
  },
  {
    accessorKey: "outputTokens",
    id: "outputTokens",
    header: "Output Tokens",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.outputTokens;
      return value ? <span>{numberFormatter(value, 0)}</span> : undefined;
    },
  },
  {
    accessorKey: "totalTokens",
    id: "totalTokens",
    header: "Total Tokens",
    meta: { defaultHidden: true },
    cell: ({ row }) => {
      const value = row.original.totalTokens;
      return value ? <span>{numberFormatter(value, 0)}</span> : undefined;
    },
  },
  {
    id: "usage",
    header: "Usage",
    enableSorting: false,
    accessorFn: (row) => row.totalTokens,
    cell: ({ row }) => {
      const { inputTokens, outputTokens, totalTokens } = row.original;
      return (
        <TokenUsageBadge
          inputUsage={inputTokens}
          outputUsage={outputTokens}
          totalUsage={totalTokens}
          inline
        />
      );
    },
  },
  {
    accessorKey: "traceTags",
    id: "traceTags",
    header: "Trace Tags",
    meta: { defaultHidden: true },
    enableSorting: false,
    cell: ({ row }) => {
      const value = row.original.traceTags;
      return (
        value &&
        value.length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {value.map((tag) => (
              <Badge key={tag} variant="secondary" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        )
      );
    },
  },
];

type SessionFilters = {
  userId?: string;
  environment?: string;
};

export function SessionsPage() {
  const navigate = useNavigate();
  const tableState = useTableState<SessionFilters>({
    filterKeys: ["userId", "environment"],
    defaultSort: "createdAt.desc",
  });

  const query = useSessionsQuery({
    page: tableState.page,
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy,
    ...tableState.filters,
  });

  const rows = useMemo(() => (query.data?.data ?? []).map(toRow), [query.data]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Sessions" description="Groups of traces sharing a session id." />

      <div className="flex flex-1 flex-col overflow-hidden px-4 py-3">
        <DataTable
          columns={columns}
          data={rows}
          isLoading={query.isLoading}
          error={query.error}
          emptyMessage="No sessions found."
          meta={query.data?.meta}
          page={tableState.page}
          pageSize={PAGE_SIZE}
          onPageChange={tableState.setPage}
          sorting={tableState.sorting}
          onSortingChange={tableState.setSorting}
          getRowId={(row) => row.id}
          onRowClick={(row) => navigate(`/sessions/${encodeURIComponent(row.id)}`)}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <FilterInput
                className="w-44"
                placeholder="Filter by userId…"
                icon={User}
                value={tableState.filters.userId}
                onCommit={(v) => tableState.setFilter("userId", v)}
              />
              <FilterInput
                className="w-44"
                placeholder="Filter by environment…"
                icon={Globe}
                value={tableState.filters.environment}
                onCommit={(v) => tableState.setFilter("environment", v)}
              />
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
    </div>
  );
}
