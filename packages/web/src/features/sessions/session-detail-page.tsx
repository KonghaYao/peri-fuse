/**
 * Session detail — merged multi-trace observation tree with traceId/observationId anchors.
 */

import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  MonitorTraceTurnTree,
  MonitorTraceTurnTreeShell,
  PaginationControls,
  ScrollArea,
  Skeleton,
} from "@peri/ui";
import { A, useParams, useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import {
  ArrowLeft,
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  ListTree,
  Users,
} from "lucide-solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  Show,
} from "solid-js";
import { searchParamValue } from "@/features/users/search-param";
import {
  toFlatObservations,
  toScoreSummary,
} from "@/shared/components/observations/observation-adapters";
import { ObservationDetailPanel } from "@/shared/components/observations/observation-detail-panel";
import { ObservationTimelineDialog } from "@/shared/components/observations/observation-timeline-dialog";
import {
  queryKeys,
  useObservationDetailQuery,
  useTraceObservationsQuery,
} from "@/shared/hooks/queries";
import { getSession } from "@/shared/lib/api";
import { formatDateTime, formatIntervalSeconds, formatTokens } from "@/shared/lib/format";
import type { Observation, SessionTrace } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

const PAGE_SIZE = 50;

const Stat: Component<{ label: string; value: string | number | JSX.Element }> = (props) => (
  <div class="flex flex-col gap-2">
    <span class="text-xs text-fg-tertiary">{props.label}</span>
    <span class="text-sm font-medium text-fg-primary">{props.value}</span>
  </div>
);

const TraceObservationsLoader: Component<{
  traceId: string;
  expanded: boolean;
  omitNoise: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoaded: (traceId: string, observations: Observation[]) => void;
}> = (props) => {
  const query = useTraceObservationsQuery(props.traceId, props.expanded);
  const observations = createMemo(() => query.data?.pages.flatMap((page) => page.data) ?? []);

  createEffect(
    on(
      () => [props.traceId, observations()] as const,
      ([traceId, list]) => props.onLoaded(traceId, list),
    ),
  );

  return (
    <Show when={props.expanded}>
      <Show when={!query.isPending} fallback={<Skeleton class="ml-24 h-80 w-[calc(100%-1.5rem)]" />}>
        <Show
          when={!query.isError}
          fallback={
            <InlineNotice tone="danger" role="alert" class="ml-24 mr-8">
              {query.error instanceof Error ? query.error.message : "Failed to load observations"}
            </InlineNotice>
          }
        >
          <MonitorTraceTurnTree
            observations={toFlatObservations(observations())}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            omitNoise={props.omitNoise}
            class="ml-16"
          />
          <Show when={query.hasNextPage}>
            <Button
              variant="ghost"
              size="sm"
              class="ml-24 mt-4"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more observations"}
            </Button>
          </Show>
        </Show>
      </Show>
    </Show>
  );
};

const TraceRootRow: Component<{
  trace: SessionTrace;
  expanded: boolean;
  onToggle: () => void;
}> = (props) => (
  <div
    role="button"
    tabIndex={0}
    onClick={props.onToggle}
    onKeyDown={(event) => event.key === "Enter" && props.onToggle()}
    aria-expanded={props.expanded}
    class="flex cursor-pointer items-center gap-6 rounded-md px-8 py-6 text-sm transition-colors hover:bg-surface-overlay/50"
  >
    <ChevronRight
      class={cn("h-14 w-14 shrink-0 transition-transform", props.expanded && "rotate-90")}
      size={14}
    />
    <ListTree class="h-14 w-14 shrink-0 text-success" size={14} />
    <span class="truncate font-semibold">{props.trace.name ?? "(unnamed trace)"}</span>
    <span class="shrink-0 text-xs text-fg-tertiary">{formatDateTime(props.trace.timestamp)}</span>
    <span class="ml-auto flex shrink-0 items-center gap-6 pl-8">
      <Show when={props.trace.latency !== null}>
        <span class="font-mono text-[11px] text-fg-tertiary">
          {formatIntervalSeconds(props.trace.latency!)}
        </span>
      </Show>
      <A
        href={`/traces/${encodeURIComponent(props.trace.id)}`}
        onClick={(event: MouseEvent) => event.stopPropagation()}
        title="Open trace detail"
        aria-label="Open trace detail"
        class="rounded p-2 text-fg-tertiary transition-colors hover:bg-surface-inset hover:text-fg-primary"
      >
        <ArrowUpRight class="h-14 w-14" size={14} />
      </A>
    </span>
  </div>
);

export const SessionDetailPage: Component = () => {
  const params = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPage = () =>
    Math.max(1, Number.parseInt(searchParamValue(searchParams.page) ?? "1", 10) || 1);

  return (
    <SessionDetailContent
      sessionId={params.sessionId}
      page={requestedPage()}
      traceAnchor={searchParamValue(searchParams.traceId) ?? null}
      observationAnchor={searchParamValue(searchParams.observationId) ?? null}
      onPageChange={(page) =>
        setSearchParams({ page: page <= 1 ? undefined : String(page) }, { replace: true })
      }
    />
  );
};

const SessionDetailContent: Component<{
  sessionId: string | undefined;
  page: number;
  traceAnchor: string | null;
  observationAnchor: string | null;
  onPageChange: (page: number) => void;
}> = (props) => {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [expandedTraceIds, setExpandedTraceIds] = createSignal<Set<string>>(new Set());
  const [loadedByTrace, setLoadedByTrace] = createSignal<Map<string, Observation[]>>(new Map());
  const [omitNoise, setOmitNoise] = createSignal(true);
  const [timelineOpen, setTimelineOpen] = createSignal(false);

  const sessionQuery = useQuery(() => ({
    queryKey: [...queryKeys.session(props.sessionId ?? ""), props.page] as const,
    queryFn: ({ signal }) => getSession(props.sessionId!, props.page, signal),
    enabled: Boolean(props.sessionId),
  }));
  const session = () => sessionQuery.data;
  const selectedQuery = useObservationDetailQuery(selectedId());

  createEffect(() => {
    const current = session();
    if (!current) return;
    if (props.observationAnchor) setSelectedId(props.observationAnchor);
    if (props.traceAnchor) {
      setExpandedTraceIds((previous) => {
        if (previous.has(props.traceAnchor!)) return previous;
        const next = new Set(previous);
        next.add(props.traceAnchor!);
        return next;
      });
    }
  });

  const selected = createMemo(() => {
    const id = selectedId();
    const current = session();
    if (!id || !current) return null;
    for (const trace of current.traces) {
      const observation = loadedByTrace()
        .get(trace.id)
        ?.find((item) => item.id === id);
      if (observation) return { observation, trace };
    }
    return null;
  });

  const selectedScores = createMemo(() => {
    const match = selected();
    if (!match) return [];
    return match.trace.scores
      .filter((score) => score.observationId === match.observation.id)
      .map(toScoreSummary);
  });

  const sessionView = createMemo(() => {
    const current = session();
    if (!current) return null;
    return {
      ...current,
      traces: current.traces.map((trace) => ({
        ...trace,
        observations: loadedByTrace().get(trace.id) ?? [],
      })),
    };
  });

  const handleLoaded = (traceId: string, observations: Observation[]) => {
    setLoadedByTrace((previous) => {
      if (previous.get(traceId) === observations) return previous;
      const next = new Map(previous);
      next.set(traceId, observations);
      return next;
    });
  };

  const toggleTrace = (traceId: string) => {
    setExpandedTraceIds((previous) => {
      const next = new Set(previous);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  };

  return (
    <div class="flex h-full flex-col">
      <div class="border-b border-border px-24 py-16">
        <A
          href="/sessions"
          class="mb-8 inline-flex items-center gap-4 text-xs text-fg-tertiary hover:text-fg-primary"
        >
          <ArrowLeft class="h-14 w-14" size={14} />
          Sessions
        </A>
        <div class="flex items-center justify-between gap-16">
          <div class="min-w-0">
            <h1 class="truncate text-lg font-semibold tracking-tight text-fg-primary">
              {props.sessionId}
            </h1>
            <Show when={session()}>
              {(current) => (
                <div class="mt-2 flex flex-wrap items-center gap-8 text-sm text-fg-tertiary">
                  <span>Started {formatDateTime(current().createdAt)}</span>
                  <Badge tone="neutral" class="font-normal">
                    Full session · all times and environments
                  </Badge>
                </div>
              )}
            </Show>
          </div>
          <Show when={session()}>
            <Button
              variant="secondary"
              size="sm"
              class="shrink-0 gap-6"
              onClick={() => setTimelineOpen(true)}
            >
              <ChartNoAxesCombined class="h-16 w-16" size={16} />
              Page timeline
            </Button>
          </Show>
        </div>

        <Show
          when={
            session() &&
            props.traceAnchor &&
            !session()!.traces.some((trace) => trace.id === props.traceAnchor)
          }
        >
          <div class="mt-12 rounded border border-warning/30 bg-warning/10 p-12 text-sm">
            The target trace is on another session page. Open its details directly to view it:
            <A
              class="ml-8 text-brand underline"
              href={`/traces/${encodeURIComponent(props.traceAnchor!)}`}
            >
              Open target trace
            </A>
          </div>
        </Show>

        <Show when={session()}>
          {(current) => (
            <div class="mt-16 flex flex-wrap gap-x-32 gap-y-12">
              <Stat label="Duration" value={formatIntervalSeconds(current().sessionDuration)} />
              <Stat label="Traces" value={current().countTraces} />
              <Stat label="Total Tokens" value={formatTokens(current().totalTokens)} />
              <Stat
                label="Users"
                value={
                  current().users.length > 0 ? (
                    <span class="flex items-center gap-4">
                      <Users class="h-14 w-14 text-fg-tertiary" size={14} />
                      {current().users.join(", ")}
                      {current().usersTruncated ? ", …" : ""}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <Stat
                label="Environment"
                value={
                  current().environment ? (
                    <Badge tone="neutral" class="rounded-sm px-4 font-normal">
                      {current().environment}
                    </Badge>
                  ) : (
                    "—"
                  )
                }
              />
            </div>
          )}
        </Show>
      </div>

      <MonitorTraceTurnTreeShell
        class="min-h-0 flex-1 p-16"
        treeToolbar={
          <Button size="sm" variant="ghost" onClick={() => setOmitNoise((value) => !value)}>
            {omitNoise() ? "Hide noise" : "Show all"}
          </Button>
        }
        tree={
          <Show
            when={!sessionQuery.isPending}
            fallback={
              <div class="space-y-12 p-8">
                <For each={[0, 1, 2]}>{() => <Skeleton class="h-96 w-full" />}</For>
              </div>
            }
          >
            <Show
              when={!sessionQuery.isError}
              fallback={
                <InlineNotice tone="danger" role="alert" class="m-16">
                  {sessionQuery.error instanceof Error
                    ? sessionQuery.error.message
                    : "Failed to load session"}
                </InlineNotice>
              }
            >
              <Show
                when={session()?.traces.length}
                fallback={
                  <EmptyState variant="inline" title="No traces in this session." class="m-16" />
                }
              >
                <ScrollArea class="h-full">
                  <div class="p-8">
                    <For each={session()?.traces ?? []}>
                      {(trace, index) => (
                        <div>
                          <Show when={index() > 0}>
                            <div class="my-8 border-t border-border" />
                          </Show>
                          <TraceRootRow
                            trace={trace}
                            expanded={expandedTraceIds().has(trace.id)}
                            onToggle={() => toggleTrace(trace.id)}
                          />
                          <TraceObservationsLoader
                            traceId={trace.id}
                            expanded={expandedTraceIds().has(trace.id)}
                            omitNoise={omitNoise()}
                            selectedId={selectedId()}
                            onSelect={setSelectedId}
                            onLoaded={handleLoaded}
                          />
                        </div>
                      )}
                    </For>
                  </div>
                </ScrollArea>
              </Show>
            </Show>
          </Show>
        }
        showDetailPlaceholder={!selectedId()}
        detail={
          <Show
            when={selectedQuery.isPending}
            fallback={
              <Show
                when={selectedQuery.isError}
                fallback={
                  <Show when={selectedQuery.data}>
                    {(observation) => (
                      <ObservationDetailPanel
                        observation={observation()}
                        scores={selectedScores()}
                      />
                    )}
                  </Show>
                }
              >
                <InlineNotice tone="danger" role="alert">
                  {selectedQuery.error instanceof Error
                    ? selectedQuery.error.message
                    : "Failed to load observation"}
                </InlineNotice>
              </Show>
            }
          >
            <Skeleton class="h-256 w-full" />
          </Show>
        }
      />

      <Show when={session()?.meta}>
        {(meta) => (
          <div class="border-t border-border px-16 py-8">
            <PaginationControls
              current={props.page}
              pageSize={PAGE_SIZE}
              total={meta().totalItems}
              onChange={props.onPageChange}
            />
          </div>
        )}
      </Show>

      <Show when={sessionView()}>
        {(view) => (
          <ObservationTimelineDialog
            traces={view().traces}
            open={timelineOpen()}
            onOpenChange={setTimelineOpen}
            omitNoise={omitNoise()}
          />
        )}
      </Show>
    </div>
  );
};
