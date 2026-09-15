import {
  type EnhancedDataTableColumn,
  LocalIsoDate,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { formatNumber, formatTokens } from "@/shared/lib/format";
import type { UserRow } from "@/shared/lib/types";

type UserFilters = {
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

function tracesHref(userId: string, filters: UserFilters) {
  const params = new URLSearchParams();
  params.set("userId", userId);
  if (filters.environment) params.set("environment", filters.environment);
  if (filters.fromTimestamp) params.set("fromTimestamp", filters.fromTimestamp);
  if (filters.toTimestamp) params.set("toTimestamp", filters.toTimestamp);
  return `/traces?${params.toString()}`;
}

export function createUsersTableColumns(
  filters: () => UserFilters,
): EnhancedDataTableColumn<UserRow>[] {
  return [
    {
      id: "id",
      header: "User",
      accessor: (row) => row.id,
      sortable: true,
      cell: (row) => (
        <A
          href={tracesHref(row.id, filters())}
          class="truncate font-medium text-brand hover:underline"
          title={`View traces for ${row.id}`}
        >
          {row.id}
        </A>
      ),
    },
    {
      id: "firstSeen",
      header: "First seen",
      accessor: (row) => row.firstSeen,
      sortable: true,
      cell: (row) => (row.firstSeen ? <LocalIsoDate date={new Date(row.firstSeen)} /> : null),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      accessor: (row) => row.lastSeen,
      sortable: true,
      cell: (row) => (row.lastSeen ? <LocalIsoDate date={new Date(row.lastSeen)} /> : null),
    },
    {
      id: "countTraces",
      header: "Traces",
      accessor: (row) => row.countTraces,
      sortable: true,
      headerClass: "text-right",
      class: "tnum text-right",
      cell: (row) => formatNumber(row.countTraces),
    },
    {
      id: "countObservations",
      header: "Observations",
      accessor: (row) => row.countObservations,
      sortable: true,
      headerClass: "text-right",
      class: "tnum text-right",
      cell: (row) => formatNumber(row.countObservations),
    },
    {
      id: "totalTokens",
      header: "Tokens",
      accessor: (row) => row.totalTokens,
      sortable: true,
      headerClass: "text-right",
      class: "tnum text-right",
      cell: (row) => formatTokens(row.totalTokens),
    },
  ];
}
