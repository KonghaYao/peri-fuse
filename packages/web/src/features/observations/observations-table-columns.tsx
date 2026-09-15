import {
  type EnhancedDataTableColumn,
  LocalIsoDate,
  MonitorObservationLevelBadge,
  MonitorObservationTypeBadge,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { formatTokens } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";

export const observationsTableColumns: EnhancedDataTableColumn<Observation>[] = [
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name ?? "",
    cell: (row) => row.name ?? <span class="text-fg-tertiary">(unnamed)</span>,
  },
  {
    id: "type",
    header: "Type",
    accessor: (row) => row.type,
    cell: (row) => <MonitorObservationTypeBadge type={row.type} />,
  },
  {
    id: "level",
    header: "Level",
    accessor: (row) => row.level,
    cell: (row) => <MonitorObservationLevelBadge level={row.level} />,
  },
  {
    id: "detail",
    header: "Detail",
    accessor: (row) => row.statusMessage ?? "",
    cell: (row) =>
      row.level === "ERROR" ? (
        <span
          class="block truncate text-danger"
          title={row.statusMessage || "No status message recorded"}
        >
          {row.statusMessage || "No status message recorded"}
        </span>
      ) : (
        "—"
      ),
  },
  {
    id: "startTime",
    header: "Start time",
    accessor: (row) => row.startTime,
    cell: (row) => (row.startTime ? <LocalIsoDate date={new Date(row.startTime)} /> : null),
  },
  {
    id: "model",
    header: "Model",
    accessor: (row) => row.model ?? "",
    cell: (row) => row.model ?? "—",
  },
  {
    id: "totalTokens",
    header: "Tokens",
    accessor: (row) => row.totalTokens,
    headerClass: "text-right",
    class: "text-right text-fg-tertiary",
    cell: (row) => (row.totalTokens > 0 ? formatTokens(row.totalTokens) : "—"),
  },
  {
    id: "traceId",
    header: "Trace",
    accessor: (row) => row.traceId ?? "",
    cell: (row) =>
      row.traceId ? (
        <A
          href={`/traces/${encodeURIComponent(row.traceId)}`}
          class="truncate font-mono text-xs text-brand hover:underline"
          title={row.traceId}
        >
          {row.traceId.slice(0, 8)}…
        </A>
      ) : (
        "—"
      ),
  },
];
