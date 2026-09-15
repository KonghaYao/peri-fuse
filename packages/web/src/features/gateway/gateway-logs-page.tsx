/**
 * Gateway Logs page — request logs + error logs with tabs.
 */
import {
  Button,
  Card,
  CardContent,
  Input,
  PageHeaderShell,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@peri/ui";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
import { LoadingRows } from "@/features/gateway/components/loading-rows";
import { useGwErrorLogsQuery, useGwRequestLogsQuery } from "@/shared/hooks/gateway-queries";
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

const RequestLogRow: Component<{ log: RequestLog }> = (props) => {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <>
      <tr
        class="cursor-pointer border-b border-border/50 transition-colors hover:bg-surface-overlay/40"
        onClick={() => setExpanded((value) => !value)}
      >
        <td class="px-16 py-10 text-xs text-fg-tertiary">
          <span class="mr-4 inline-block align-middle">
            <Show when={expanded()} fallback={<ChevronRight class="h-12 w-12" size={12} />}>
              <ChevronDown class="h-12 w-12" size={12} />
            </Show>
          </span>
          {new Date(props.log.startTime).toLocaleString()}
        </td>
        <td class="px-16 py-10 font-mono text-xs text-fg-primary">{props.log.model || "—"}</td>
        <td class="hidden px-16 py-10 text-xs text-fg-secondary md:table-cell">
          {props.log.provider || "—"}
        </td>
        <td class="px-16 py-10 text-right font-mono text-xs text-fg-tertiary">
          {props.log.totalTokens.toLocaleString()}
        </td>
        <td class="px-16 py-10 text-right font-mono text-xs text-fg-secondary">
          ${props.log.spend.toFixed(5)}
        </td>
        <td class={cn("px-16 py-10 text-xs font-medium capitalize", statusColor(props.log.status))}>
          {props.log.status}
        </td>
        <td class="hidden px-16 py-10 text-right text-xs text-fg-tertiary lg:table-cell">
          {formatDuration(props.log.startTime, props.log.endTime)}
        </td>
        <td class="hidden px-16 py-10 text-right text-xs text-fg-tertiary lg:table-cell">
          {props.log.ttftMs != null ? `${props.log.ttftMs}ms` : "—"}
        </td>
      </tr>
      <Show when={expanded()}>
        <tr class="border-b border-border/50 bg-surface-inset/50">
          <td colspan={8} class="px-32 py-12">
            <div class="grid gap-12 text-xs lg:grid-cols-2">
              <div>
                <p class="mb-4 font-medium text-fg-secondary">Metadata</p>
                <pre class="max-h-160 overflow-auto rounded-md border border-border bg-surface-raised p-8 font-mono text-[11px] text-fg-tertiary">
                  {JSON.stringify(props.log.metadata, null, 2)}
                </pre>
              </div>
              <div>
                <p class="mb-4 font-medium text-fg-secondary">Messages</p>
                <pre class="max-h-160 overflow-auto rounded-md border border-border bg-surface-raised p-8 font-mono text-[11px] text-fg-tertiary">
                  {props.log.messages
                    ? JSON.stringify(props.log.messages, null, 2)
                    : "(not recorded)"}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      </Show>
    </>
  );
};

const RequestLogsTab: Component = () => {
  const [model, setModel] = createSignal("");
  const [provider, setProvider] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [offset, setOffset] = createSignal(0);

  const query = useGwRequestLogsQuery({
    model: model() || undefined,
    provider: provider() || undefined,
    status: status() || undefined,
    limit: PAGE_SIZE,
    offset: offset(),
  });

  const logs = () => query.data?.data ?? [];
  const total = () => query.data?.total ?? 0;

  return (
    <Show
      when={query.isPending}
      fallback={
        <Show
          when={query.isError}
          fallback={
            <div class="space-y-16">
              <div class="flex flex-wrap items-center gap-12">
                <Input
                  class="w-160"
                  placeholder="Filter model…"
                  value={model()}
                  onInput={(e) => {
                    setModel(e.currentTarget.value);
                    setOffset(0);
                  }}
                />
                <Input
                  class="w-160"
                  placeholder="Filter provider…"
                  value={provider()}
                  onInput={(e) => {
                    setProvider(e.currentTarget.value);
                    setOffset(0);
                  }}
                />
                <select
                  class="h-36 rounded-md border border-border bg-surface-raised px-12 text-[13px] text-fg-secondary"
                  value={status()}
                  onChange={(e) => {
                    setStatus(e.currentTarget.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All statuses</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                </select>
                <span class="ml-auto text-xs text-fg-tertiary">
                  {total()} total · showing {offset() + 1}–{Math.min(offset() + PAGE_SIZE, total())}
                </span>
              </div>

              <Card>
                <CardContent class="p-0">
                  <Show
                    when={logs().length > 0}
                    fallback={
                      <p class="py-32 text-center text-sm text-fg-tertiary">
                        No request logs found.
                      </p>
                    }
                  >
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                          <th class="px-16 py-10">Time</th>
                          <th class="px-16 py-10">Model</th>
                          <th class="hidden px-16 py-10 md:table-cell">Provider</th>
                          <th class="px-16 py-10 text-right">Tokens</th>
                          <th class="px-16 py-10 text-right">Spend</th>
                          <th class="px-16 py-10">Status</th>
                          <th class="hidden px-16 py-10 text-right lg:table-cell">Duration</th>
                          <th class="hidden px-16 py-10 text-right lg:table-cell">TTFT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {logs().map((log) => (
                          <RequestLogRow log={log} />
                        ))}
                      </tbody>
                    </table>
                  </Show>
                </CardContent>
              </Card>

              <Show when={total() > PAGE_SIZE}>
                <div class="flex justify-center gap-8">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={offset() === 0}
                    onClick={() => setOffset(Math.max(0, offset() - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={offset() + PAGE_SIZE >= total()}
                    onClick={() => setOffset(offset() + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </Show>
            </div>
          }
        >
          <div
            role="alert"
            class="flex items-center justify-between rounded-md border border-danger/30 bg-danger-subtle px-12 py-8"
          >
            <p class="text-sm text-danger">
              {query.error instanceof Error ? query.error.message : "Failed to load request logs"}
            </p>
            <Button
              variant="default"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              Retry
            </Button>
          </div>
        </Show>
      }
    >
      <LoadingRows />
    </Show>
  );
};

const ErrorLogsTab: Component = () => {
  const [offset, setOffset] = createSignal(0);
  const query = useGwErrorLogsQuery({ limit: PAGE_SIZE, offset: offset() });
  const logs = () => query.data?.data ?? [];
  const total = () => query.data?.total ?? 0;

  return (
    <Show
      when={query.isPending}
      fallback={
        <Show
          when={query.isError}
          fallback={
            <div class="space-y-16">
              <Card>
                <CardContent class="p-0">
                  <Show
                    when={logs().length > 0}
                    fallback={
                      <p class="py-32 text-center text-sm text-fg-tertiary">
                        No error logs. Everything looks healthy.
                      </p>
                    }
                  >
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                          <th class="px-16 py-10">Time</th>
                          <th class="px-16 py-10">Model</th>
                          <th class="hidden px-16 py-10 md:table-cell">Provider</th>
                          <th class="px-16 py-10">Exception</th>
                          <th class="px-16 py-10">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {logs().map((log) => (
                          <tr class="border-b border-border/50 hover:bg-surface-overlay/40">
                            <td class="px-16 py-10 text-xs text-fg-tertiary">
                              {new Date(log.startTime).toLocaleString()}
                            </td>
                            <td class="px-16 py-10 font-mono text-xs text-fg-primary">
                              {log.modelGroup || "—"}
                            </td>
                            <td class="hidden px-16 py-10 text-xs text-fg-secondary md:table-cell">
                              {log.provider || "—"}
                            </td>
                            <td class="px-16 py-10">
                              <span class="rounded bg-danger-subtle px-6 py-2 font-mono text-[10px] text-danger">
                                {log.exceptionType}
                              </span>
                            </td>
                            <td class="max-w-[300px] truncate px-16 py-10 text-xs text-fg-secondary">
                              {log.exceptionMessage}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Show>
                </CardContent>
              </Card>

              <Show when={total() > PAGE_SIZE}>
                <div class="flex justify-center gap-8">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={offset() === 0}
                    onClick={() => setOffset(Math.max(0, offset() - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={offset() + PAGE_SIZE >= total()}
                    onClick={() => setOffset(offset() + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </Show>
            </div>
          }
        >
          <div
            role="alert"
            class="flex items-center justify-between rounded-md border border-danger/30 bg-danger-subtle px-12 py-8"
          >
            <p class="text-sm text-danger">
              {query.error instanceof Error ? query.error.message : "Failed to load error logs"}
            </p>
            <Button
              variant="default"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              Retry
            </Button>
          </div>
        </Show>
      }
    >
      <LoadingRows />
    </Show>
  );
};

const LogsContent: Component = () => (
  <div class="p-24">
    <Tabs defaultValue="requests">
      <TabsList>
        <TabsTrigger value="requests">Request Logs</TabsTrigger>
        <TabsTrigger value="errors">Error Logs</TabsTrigger>
      </TabsList>
      <TabsContent value="requests" class="mt-16">
        <RequestLogsTab />
      </TabsContent>
      <TabsContent value="errors" class="mt-16">
        <ErrorLogsTab />
      </TabsContent>
    </Tabs>
  </div>
);

export const GatewayLogsPage: Component = () => (
  <GatewayProjectGate title="Logs" description="Request and error logs from the gateway proxy.">
    <div class="flex h-full flex-col">
      <PageHeaderShell title="Logs" description="Request and error logs from the gateway proxy." />
      <div class="flex-1 overflow-y-auto">
        <LogsContent />
      </div>
    </div>
  </GatewayProjectGate>
);
