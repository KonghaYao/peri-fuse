/**
 * Gateway Logs page — request logs + error logs with tabs.
 */
import {
  BlockLoadingRows,
  Button,
  Input,
  InlineForm,
  PageHeaderShell,
  PaginationControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableView,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@peri/ui";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
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
      <TableRow
        class="cursor-pointer"
        onClick={() => setExpanded((value) => !value)}
      >
        <TableCell class="text-xs text-fg-tertiary">
          <span class="mr-4 inline-block align-middle">
            <Show when={expanded()} fallback={<ChevronRight class="h-12 w-12" size={12} />}>
              <ChevronDown class="h-12 w-12" size={12} />
            </Show>
          </span>
          {new Date(props.log.startTime).toLocaleString()}
        </TableCell>
        <TableCell class="font-mono text-xs text-fg-primary">{props.log.model || "—"}</TableCell>
        <TableCell class="hidden text-xs text-fg-secondary md:table-cell">
          {props.log.provider || "—"}
        </TableCell>
        <TableCell class="text-right font-mono text-xs text-fg-tertiary">
          {props.log.totalTokens.toLocaleString()}
        </TableCell>
        <TableCell class="text-right font-mono text-xs text-fg-secondary">
          ${props.log.spend.toFixed(5)}
        </TableCell>
        <TableCell class={cn("text-xs font-medium capitalize", statusColor(props.log.status))}>
          {props.log.status}
        </TableCell>
        <TableCell class="hidden text-right text-xs text-fg-tertiary lg:table-cell">
          {formatDuration(props.log.startTime, props.log.endTime)}
        </TableCell>
        <TableCell class="hidden text-right text-xs text-fg-tertiary lg:table-cell">
          {props.log.ttftMs != null ? `${props.log.ttftMs}ms` : "—"}
        </TableCell>
      </TableRow>
      <Show when={expanded()}>
        <TableRow class="bg-surface-inset/50">
          <TableCell colSpan={8} class="px-32 py-12">
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
          </TableCell>
        </TableRow>
      </Show>
    </>
  );
};

const RequestLogsTab: Component = () => {
  const [model, setModel] = createSignal("");
  const [provider, setProvider] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [offset, setOffset] = createSignal(0);

  const query = useGwRequestLogsQuery(() => ({
    model: model() || undefined,
    provider: provider() || undefined,
    status: status() || undefined,
    limit: PAGE_SIZE,
    offset: offset(),
  }));

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
              <TableView>
                <TableView.Toolbar>
                  <InlineForm minTrack={144} gap={8} class="px-8">
                    <InlineForm.Field>
                      <Input
                        placeholder="Filter model…"
                        value={model()}
                        onInput={(e) => {
                          setModel(e.currentTarget.value);
                          setOffset(0);
                        }}
                      />
                    </InlineForm.Field>
                    <InlineForm.Field>
                      <Input
                        placeholder="Filter provider…"
                        value={provider()}
                        onInput={(e) => {
                          setProvider(e.currentTarget.value);
                          setOffset(0);
                        }}
                      />
                    </InlineForm.Field>
                    <InlineForm.Field>
                      <select
                        class="h-36 w-full rounded-md border border-border bg-surface-raised px-12 text-[13px] text-fg-secondary"
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
                    </InlineForm.Field>
                  </InlineForm>
                </TableView.Toolbar>
                <TableView.Body>
                  <Show
                    when={logs().length > 0}
                    fallback={
                      <p class="py-32 text-center text-sm text-fg-tertiary">
                        No request logs found.
                      </p>
                    }
                  >
                    <Table wrapperClass="min-h-0 flex-1">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>Model</TableHead>
                          <TableHead class="hidden md:table-cell">Provider</TableHead>
                          <TableHead class="text-right">Tokens</TableHead>
                          <TableHead class="text-right">Spend</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead class="hidden text-right lg:table-cell">Duration</TableHead>
                          <TableHead class="hidden text-right lg:table-cell">TTFT</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {logs().map((log) => (
                          <RequestLogRow log={log} />
                        ))}
                      </TableBody>
                    </Table>
                  </Show>
                </TableView.Body>
                <Show when={total() > 0}>
                  <TableView.Footer>
                    <PaginationControls
                      class="px-8 py-8"
                      current={Math.floor(offset() / PAGE_SIZE) + 1}
                      pageSize={PAGE_SIZE}
                      total={total()}
                      showTotal
                      onChange={(page) => setOffset((page - 1) * PAGE_SIZE)}
                    />
                  </TableView.Footer>
                </Show>
              </TableView>
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
      <BlockLoadingRows />
    </Show>
  );
};

const ErrorLogsTab: Component = () => {
  const [offset, setOffset] = createSignal(0);
  const query = useGwErrorLogsQuery(() => ({ limit: PAGE_SIZE, offset: offset() }));
  const logs = () => query.data?.data ?? [];
  const total = () => query.data?.total ?? 0;

  return (
    <Show
      when={query.isPending}
      fallback={
        <Show
          when={query.isError}
          fallback={
            <TableView>
              <TableView.Body>
                <Show
                  when={logs().length > 0}
                  fallback={
                    <p class="py-32 text-center text-sm text-fg-tertiary">
                      No error logs. Everything looks healthy.
                    </p>
                  }
                >
                  <Table wrapperClass="min-h-0 flex-1">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead class="hidden md:table-cell">Provider</TableHead>
                        <TableHead>Exception</TableHead>
                        <TableHead>Message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs().map((log) => (
                        <TableRow>
                          <TableCell class="text-xs text-fg-tertiary">
                            {new Date(log.startTime).toLocaleString()}
                          </TableCell>
                          <TableCell class="font-mono text-xs text-fg-primary">
                            {log.modelGroup || "—"}
                          </TableCell>
                          <TableCell class="hidden text-xs text-fg-secondary md:table-cell">
                            {log.provider || "—"}
                          </TableCell>
                          <TableCell>
                            <span class="rounded bg-danger-subtle px-6 py-2 font-mono text-[10px] text-danger">
                              {log.exceptionType}
                            </span>
                          </TableCell>
                          <TableCell class="max-w-[300px] truncate text-xs text-fg-secondary">
                            {log.exceptionMessage}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Show>
              </TableView.Body>
              <Show when={total() > 0}>
                <TableView.Footer>
                  <PaginationControls
                    class="px-8 py-8"
                    current={Math.floor(offset() / PAGE_SIZE) + 1}
                    pageSize={PAGE_SIZE}
                    total={total()}
                    showTotal
                    onChange={(page) => setOffset((page - 1) * PAGE_SIZE)}
                  />
                </TableView.Footer>
              </Show>
            </TableView>
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
      <BlockLoadingRows />
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
