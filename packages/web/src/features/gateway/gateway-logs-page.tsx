/**
 * Gateway Logs page — request logs + error logs with tabs.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import {
  useGwErrorLogsQuery,
  useGwRequestLogsQuery,
} from "@/shared/hooks/gateway-queries";
import type { RequestLog } from "@/shared/lib/gateway-api";
import { cn } from "@/shared/lib/utils";

const PAGE_SIZE = 50;

function formatDuration(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return `${ms}ms`;
}

function statusColor(status: string): string {
  if (status === "success") return "text-success";
  if (status === "failure") return "text-danger";
  return "text-fg-tertiary";
}

function RequestLogRow({ log }: { log: RequestLog }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/50 transition-colors hover:bg-surface-overlay/40"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-2.5 text-xs text-fg-tertiary">
          <span className="mr-1 inline-block align-middle">
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </span>
          {new Date(log.startTime).toLocaleString()}
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-fg-primary">{log.model || "—"}</td>
        <td className="hidden px-4 py-2.5 text-xs text-fg-secondary md:table-cell">
          {log.provider || "—"}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-tertiary">
          {log.totalTokens.toLocaleString()}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-secondary">
          ${log.spend.toFixed(5)}
        </td>
        <td className={cn("px-4 py-2.5 text-xs font-medium capitalize", statusColor(log.status))}>
          {log.status}
        </td>
        <td className="hidden px-4 py-2.5 text-right text-xs text-fg-tertiary lg:table-cell">
          {formatDuration(log.startTime, log.endTime)}
        </td>
        <td className="hidden px-4 py-2.5 text-right text-xs text-fg-tertiary lg:table-cell">
          {log.ttftMs != null ? `${log.ttftMs}ms` : "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50 bg-surface-inset/50">
          <td colSpan={8} className="px-8 py-3">
            <div className="grid gap-3 text-xs lg:grid-cols-2">
              <div>
                <p className="mb-1 font-medium text-fg-secondary">Metadata</p>
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-surface-raised p-2 font-mono text-[11px] text-fg-tertiary">
                  {JSON.stringify(log.metadata, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1 font-medium text-fg-secondary">Messages</p>
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-surface-raised p-2 font-mono text-[11px] text-fg-tertiary">
                  {log.messages ? JSON.stringify(log.messages, null, 2) : "(not recorded)"}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function RequestLogsTab() {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);

  const query = useGwRequestLogsQuery({
    model: model || undefined,
    provider: provider || undefined,
    status: status || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  if (query.isLoading) return <LoadingRows />;
  if (query.error) return <ErrorState error={query.error} />;

  const logs = query.data?.data ?? [];
  const total = query.data?.total ?? 0;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="w-40"
          placeholder="Filter model…"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setOffset(0);
          }}
        />
        <Input
          className="w-40"
          placeholder="Filter provider…"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setOffset(0);
          }}
        />
        <select
          className="h-9 rounded-md border border-border bg-surface-raised px-3 text-[13px] text-fg-secondary"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <span className="ml-auto text-xs text-fg-tertiary">
          {total} total · showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <EmptyState message="No request logs found." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th className="px-4 py-2.5">Time</th>
                  <th className="px-4 py-2.5">Model</th>
                  <th className="hidden px-4 py-2.5 md:table-cell">Provider</th>
                  <th className="px-4 py-2.5 text-right">Tokens</th>
                  <th className="px-4 py-2.5 text-right">Spend</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="hidden px-4 py-2.5 text-right lg:table-cell">Duration</th>
                  <th className="hidden px-4 py-2.5 text-right lg:table-cell">TTFT</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <RequestLogRow key={log.id} log={log} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex justify-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-secondary disabled:opacity-40"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-secondary disabled:opacity-40"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorLogsTab() {
  const query = useGwErrorLogsQuery({ limit: PAGE_SIZE });

  if (query.isLoading) return <LoadingRows />;
  if (query.error) return <ErrorState error={query.error} />;

  const logs = query.data?.data ?? [];

  return (
    <Card>
      <CardContent className="p-0">
        {logs.length === 0 ? (
          <EmptyState message="No error logs. Everything looks healthy." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                <th className="px-4 py-2.5">Time</th>
                <th className="px-4 py-2.5">Model</th>
                <th className="hidden px-4 py-2.5 md:table-cell">Provider</th>
                <th className="px-4 py-2.5">Exception</th>
                <th className="px-4 py-2.5">Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-border/50 hover:bg-surface-overlay/40">
                  <td className="px-4 py-2.5 text-xs text-fg-tertiary">
                    {new Date(log.startTime).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-fg-primary">
                    {log.modelGroup || "—"}
                  </td>
                  <td className="hidden px-4 py-2.5 text-xs text-fg-secondary md:table-cell">
                    {log.provider || "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-danger-subtle px-1.5 py-0.5 font-mono text-[10px] text-danger">
                      {log.exceptionType}
                    </span>
                  </td>
                  <td className="max-w-[300px] truncate px-4 py-2.5 text-xs text-fg-secondary">
                    {log.exceptionMessage}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function LogsContent() {
  return (
    <div className="p-6">
      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Request Logs</TabsTrigger>
          <TabsTrigger value="errors">Error Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="requests" className="mt-4">
          <RequestLogsTab />
        </TabsContent>
        <TabsContent value="errors" className="mt-4">
          <ErrorLogsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function GatewayLogsPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Logs" description="Request and error logs from the gateway proxy." />
      <div className="flex-1 overflow-y-auto">
        <LogsContent />
      </div>
    </div>
  );
}
