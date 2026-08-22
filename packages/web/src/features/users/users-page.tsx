/**
 * Users page — Spectra §8 workflow screen.
 *
 * Focus is filter + table (no stat cards — aggregates belong to the
 * dashboard). Each row links through to the traces list pre-filtered by
 * `userId`. State is URL-synced via useTableState.
 */

import { Globe, Search } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { DateFilterInput } from "@/shared/components/date-filter-input";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { Pagination } from "@/shared/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { useUsersQuery } from "@/shared/hooks/queries";
import { useTableState } from "@/shared/hooks/use-table-state";
import { formatDateTime, formatNumber, formatTokens } from "@/shared/lib/format";
import type { UserRow } from "@/shared/lib/types";

const PAGE_SIZE = 25;

type UserFilters = {
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

export function UsersPage() {
  const userFilterRef = useRef<FilterInputHandle>(null);
  const environmentFilterRef = useRef<FilterInputHandle>(null);
  const tableState = useTableState<UserFilters>({
    filterKeys: ["userId", "environment", "fromTimestamp", "toTimestamp"],
    defaultSort: "lastSeen.desc",
  });

  const query = useUsersQuery({
    page: tableState.page,
    limit: PAGE_SIZE,
    orderBy: tableState.orderBy,
    ...tableState.filters,
  });

  const users: UserRow[] = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Users"
        description="End users and usage derived from traces in the selected window."
      />

      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <FilterInput
          ref={userFilterRef}
          className="w-52"
          placeholder="Filter by user id…"
          icon={Search}
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
          className="w-36"
          value={tableState.filters.fromTimestamp}
          onCommit={(v) => tableState.setFilter("fromTimestamp", v)}
          placeholder="From date…"
          title="User activity start date"
          boundary="start"
        />
        <DateFilterInput
          className="w-36"
          value={tableState.filters.toTimestamp}
          onCommit={(v) => tableState.setFilter("toTimestamp", v)}
          placeholder="To date…"
          title="User activity end date"
          boundary="end"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            userFilterRef.current?.commit();
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
      ) : users.length === 0 ? (
        <EmptyState
          message={
            tableState.activeFilterCount > 0
              ? "No users match the current filters."
              : "No users found."
          }
        />
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right">Traces</TableHead>
                  <TableHead className="text-right">Observations</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="max-w-[240px]">
                      <Link
                        to={`/traces?${new URLSearchParams(
                          Object.entries({
                            userId: u.id,
                            environment: tableState.filters.environment,
                            fromTimestamp: tableState.filters.fromTimestamp,
                            toTimestamp: tableState.filters.toTimestamp,
                          }).filter((entry): entry is [string, string] => Boolean(entry[1])),
                        ).toString()}`}
                        className="truncate font-medium text-brand hover:underline"
                        title={`View traces for ${u.id}`}
                      >
                        {u.id}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-fg-tertiary">
                      {formatDateTime(u.firstSeen)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-fg-tertiary">
                      {formatDateTime(u.lastSeen)}
                    </TableCell>
                    <TableCell className="tnum text-right">{formatNumber(u.countTraces)}</TableCell>
                    <TableCell className="tnum text-right">
                      {formatNumber(u.countObservations)}
                    </TableCell>
                    <TableCell className="tnum text-right">{formatTokens(u.totalTokens)}</TableCell>
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
