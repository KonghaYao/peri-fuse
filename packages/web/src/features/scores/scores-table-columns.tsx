import { Badge, type EnhancedDataTableColumn, LocalIsoDate } from "@peri/ui";
import { A } from "@solidjs/router";
import type { Score } from "@/shared/lib/types";

function scoreDisplay(s: Score): string {
  if (s.stringValue !== null && s.stringValue !== undefined) return s.stringValue;
  if (s.value !== null && s.value !== undefined) {
    return Number.isInteger(s.value) ? String(s.value) : s.value.toFixed(4);
  }
  return "—";
}

export const scoresTableColumns: EnhancedDataTableColumn<Score>[] = [
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name,
    cell: (row) => <span class="truncate font-medium">{row.name}</span>,
  },
  {
    id: "value",
    header: "Value",
    accessor: (row) => scoreDisplay(row),
    headerClass: "text-right",
    class: "text-right font-mono",
    cell: (row) => scoreDisplay(row),
  },
  {
    id: "dataType",
    header: "Data type",
    accessor: (row) => row.dataType,
    cell: (row) => <Badge>{row.dataType}</Badge>,
  },
  {
    id: "source",
    header: "Source",
    accessor: (row) => row.source,
    cell: (row) => <Badge tone="neutral">{row.source}</Badge>,
  },
  {
    id: "timestamp",
    header: "Timestamp",
    accessor: (row) => row.timestamp,
    cell: (row) => (row.timestamp ? <LocalIsoDate date={new Date(row.timestamp)} /> : null),
  },
  {
    id: "traceId",
    header: "Trace",
    accessor: (row) => row.traceId ?? "",
    cell: (row) =>
      row.traceId ? (
        <A
          href={`/traces/${encodeURIComponent(row.traceId)}`}
          class="font-mono text-xs text-brand hover:underline"
          title={row.traceId}
        >
          {row.traceId.slice(0, 8)}…
        </A>
      ) : (
        <span class="text-fg-tertiary">Unlinked</span>
      ),
  },
  {
    id: "comment",
    header: "Comment",
    accessor: (row) => row.comment ?? "",
    cell: (row) => <span class="truncate text-fg-tertiary">{row.comment ?? "—"}</span>,
  },
];
