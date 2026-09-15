import {
  Badge,
  type EnhancedDataTableColumn,
  LocalIsoDate,
  MonitorObservationTypeBadge,
} from "@peri/ui";
import { A } from "@solidjs/router";
import { formatDuration } from "@/shared/lib/format";
import type { ErrorEvent } from "@/shared/lib/types";

export const errorsTableColumns: EnhancedDataTableColumn<ErrorEvent>[] = [
  {
    id: "startTime",
    header: "Time",
    accessor: (row) => row.startTime,
    cell: (row) => (row.startTime ? <LocalIsoDate date={new Date(row.startTime)} /> : "—"),
  },
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name ?? "",
    cell: (row) => row.name ?? <span class="text-fg-tertiary">Unnamed observation</span>,
  },
  {
    id: "message",
    header: "Message",
    accessor: (row) => row.statusMessage ?? "",
    cell: (row) => (
      <span
        class="block max-w-320 truncate font-mono text-11 text-danger"
        title={row.statusMessage ?? "No status message recorded"}
      >
        {row.statusMessage ?? "No status message recorded"}
      </span>
    ),
  },
  {
    id: "type",
    header: "Type",
    accessor: (row) => row.type,
    cell: (row) => <MonitorObservationTypeBadge type={row.type} />,
  },
  {
    id: "model",
    header: "Model",
    accessor: (row) => row.model ?? "",
    cell: (row) =>
      row.model ? (
        <span class="truncate font-mono text-11 text-fg-secondary">{row.model}</span>
      ) : (
        "—"
      ),
  },
  {
    id: "trace",
    header: "Trace",
    accessor: (row) => row.traceName ?? row.traceId ?? "",
    cell: (row) => {
      const label = row.traceName ?? row.traceId ?? "Unknown trace";
      if (!row.traceId) return label;
      return (
        <A
          href={`/traces/${encodeURIComponent(row.traceId)}`}
          class="truncate text-brand hover:underline"
          title={row.traceId}
          onClick={(event) => event.stopPropagation()}
        >
          {label}
        </A>
      );
    },
  },
  {
    id: "environment",
    header: "Environment",
    accessor: (row) => row.environment ?? "",
    cell: (row) =>
      row.environment ? (
        <Badge tone="neutral" class="font-mono text-10">
          {row.environment}
        </Badge>
      ) : (
        "—"
      ),
  },
  {
    id: "duration",
    header: "Duration",
    accessor: (row) => row.endTime ?? "",
    headerClass: "text-right",
    class: "text-right font-mono text-11 text-fg-tertiary",
    cell: (row) =>
      row.endTime ? formatDuration(row.startTime, row.endTime) : "—",
  },
];
