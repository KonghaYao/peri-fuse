/**
 * Sessions table — lite replica of web's sessions table use-case
 * (web/src/components/table/use-cases/sessions.tsx).
 *
 * Sessions are derived server-side from `traces.session_id` (lite mode has no
 * dedicated sessions store). All columns are server-sorted/served; the column
 * set mirrors the original minus bookmark/scores (no lite backend support).
 */

import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DataTable } from "@/components/data-table";
import { LocalIsoDate } from "@/components/local-iso-date";
import { PageHeader } from "@/components/state";
import TableIdOrName from "@/components/table-id";
import { TokenUsageBadge } from "@/components/token-usage-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listSessions } from "@/lib/api";
import { formatIntervalSeconds, numberFormatter, usdFormatter } from "@/lib/format";
import type { SessionRow } from "@/lib/types";

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

type Filters = {
  userId?: string;
  environment?: string;
};

export function SessionsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);

  const [userIdInput, setUserIdInput] = useState("");
  const [environmentInput, setEnvironmentInput] = useState("");
  const [filters, setFilters] = useState<Filters>({});

  const orderBy =
    sorting.length > 0
      ? `${sorting[0]?.id}.${sorting[0]?.desc ? "desc" : "asc"}`
      : "createdAt.desc";

  const query = useQuery({
    queryKey: ["sessions", page, filters, orderBy],
    queryFn: () =>
      listSessions({
        page,
        limit: PAGE_SIZE,
        orderBy,
        ...filters,
      }),
  });

  const rows = useMemo(() => (query.data?.data ?? []).map(toRow), [query.data]);

  const applyFilters = () => {
    setPage(1);
    setFilters({
      userId: userIdInput.trim() || undefined,
      environment: environmentInput.trim() || undefined,
    });
  };

  const handleSortingChange = (next: SortingState) => {
    setPage(1);
    setSorting(next);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Sessions" description="Groups of traces sharing a session id." />

      <div className="flex-1 overflow-auto px-4 py-3">
        <DataTable
          columns={columns}
          data={rows}
          isLoading={query.isLoading}
          error={query.error}
          emptyMessage="No sessions found."
          meta={query.data?.meta}
          page={page}
          onPageChange={setPage}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          getRowId={(row) => row.id}
          onRowClick={(row) => navigate(`/sessions/${encodeURIComponent(row.id)}`)}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
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
