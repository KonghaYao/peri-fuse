import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Pagination } from "@/components/pagination";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/state";
import { Badge } from "@/components/ui/badge";
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
import { listScores } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Score } from "@/lib/types";

const PAGE_SIZE = 25;
const ALL = "__all__";

type Filters = { name?: string; source?: string; dataType?: string };

function scoreDisplay(s: Score): string {
  if (s.stringValue !== null && s.stringValue !== undefined) return s.stringValue;
  if (s.value !== null && s.value !== undefined) {
    return Number.isInteger(s.value) ? String(s.value) : s.value.toFixed(4);
  }
  return "—";
}

export function ScoresPage() {
  const [page, setPage] = useState(1);
  const [nameInput, setNameInput] = useState("");
  const [sourceInput, setSourceInput] = useState<string>(ALL);
  const [dataTypeInput, setDataTypeInput] = useState<string>(ALL);
  const [filters, setFilters] = useState<Filters>({});

  const query = useQuery({
    queryKey: ["scores", page, filters],
    queryFn: () => listScores({ page, limit: PAGE_SIZE, ...filters }),
  });

  const applyFilters = () => {
    setPage(1);
    setFilters({
      name: nameInput.trim() || undefined,
      source: sourceInput !== ALL ? sourceInput : undefined,
      dataType: dataTypeInput !== ALL ? dataTypeInput : undefined,
    });
  };

  const scores: Score[] = query.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Scores"
        description="Evaluation scores attached to traces and observations."
      />

      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <Input
          className="h-8 w-52"
          placeholder="Filter by name…"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyFilters()}
        />
        <Select value={sourceInput} onValueChange={setSourceInput}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            <SelectItem value="API">API</SelectItem>
            <SelectItem value="EVAL">EVAL</SelectItem>
            <SelectItem value="ANNOTATION">ANNOTATION</SelectItem>
          </SelectContent>
        </Select>
        <Select value={dataTypeInput} onValueChange={setDataTypeInput}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue placeholder="Data type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            <SelectItem value="NUMERIC">NUMERIC</SelectItem>
            <SelectItem value="CATEGORICAL">CATEGORICAL</SelectItem>
            <SelectItem value="BOOLEAN">BOOLEAN</SelectItem>
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
      ) : scores.length === 0 ? (
        <EmptyState message="No scores found." />
      ) : (
        <>
          <div className="flex-1 overflow-auto px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Data type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Trace</TableHead>
                  <TableHead>Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scores.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-[200px] truncate font-medium">{s.name}</TableCell>
                    <TableCell className="text-right font-mono">{scoreDisplay(s)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.dataType}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="muted">{s.source}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(s.timestamp)}
                    </TableCell>
                    <TableCell className="max-w-[120px]">
                      <Link
                        to={`/traces/${encodeURIComponent(s.traceId)}`}
                        className="font-mono text-xs text-primary hover:underline"
                        title={s.traceId}
                      >
                        {s.traceId.slice(0, 8)}…
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-muted-foreground">
                      {s.comment ?? "—"}
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
