import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LevelBadge, ObservationTypeBadge } from "@/components/observation-badges";
import { Pagination } from "@/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listObservations } from "@/lib/api";
import { formatCost, formatDateTime, formatTokens } from "@/lib/format";
import type { Observation } from "@/lib/types";

const PAGE_SIZE = 25;
const ALL = "__all__";

type Filters = { name?: string; type?: string; level?: string };

export function ObservationsPage() {
  const [page, setPage] = useState(1);
  const [nameInput, setNameInput] = useState("");
  const [typeInput, setTypeInput] = useState<string>(ALL);
  const [levelInput, setLevelInput] = useState<string>(ALL);
  const [filters, setFilters] = useState<Filters>({});

  const query = useQuery({
    queryKey: ["observations", page, filters],
    queryFn: () => listObservations({ page, limit: PAGE_SIZE, ...filters }),
  });

  const applyFilters = () => {
    setPage(1);
    setFilters({
      name: nameInput.trim() || undefined,
      type: typeInput !== ALL ? typeInput : undefined,
      level: levelInput !== ALL ? levelInput : undefined,
    });
  };

  const observations: Observation[] = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Observations"
        description="Spans, generations and events across all traces."
      />

      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <Input
          className="h-8 w-52"
          placeholder="Filter by name…"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyFilters()}
        />
        <Select value={typeInput} onValueChange={setTypeInput}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            <SelectItem value="SPAN">SPAN</SelectItem>
            <SelectItem value="GENERATION">GENERATION</SelectItem>
            <SelectItem value="EVENT">EVENT</SelectItem>
          </SelectContent>
        </Select>
        <Select value={levelInput} onValueChange={setLevelInput}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All levels</SelectItem>
            <SelectItem value="DEBUG">DEBUG</SelectItem>
            <SelectItem value="DEFAULT">DEFAULT</SelectItem>
            <SelectItem value="WARNING">WARNING</SelectItem>
            <SelectItem value="ERROR">ERROR</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={applyFilters}>
          <Search className="h-4 w-4" />
          Search
        </Button>
      </div>

      {query.isLoading ? (
        <LoadingRows />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : observations.length === 0 ? (
        <EmptyState message="No observations found." />
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Start time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {observations.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="max-w-[220px] truncate font-medium">
                      {o.name ?? <span className="text-muted-foreground">(unnamed)</span>}
                    </TableCell>
                    <TableCell>
                      <ObservationTypeBadge type={o.type} />
                    </TableCell>
                    <TableCell>
                      <LevelBadge level={o.level} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(o.startTime)}
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate text-muted-foreground">
                      {o.model ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {o.totalTokens > 0 ? formatTokens(o.totalTokens) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatCost(o.calculatedTotalCost ?? null)}
                    </TableCell>
                    <TableCell className="max-w-[120px]">
                      {o.traceId ? (
                        <Link
                          to={`/traces/${encodeURIComponent(o.traceId)}`}
                          className="truncate font-mono text-xs text-primary hover:underline"
                          title={o.traceId}
                        >
                          {o.traceId.slice(0, 8)}…
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-border px-4 py-2">
            <Pagination meta={query.data?.meta} page={page} onPageChange={setPage} />
          </div>
        </>
      )}
    </div>
  );
}
