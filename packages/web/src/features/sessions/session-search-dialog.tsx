import { Dialog, DialogContent, EmptyState } from "@peri/ui";
import { useNavigate } from "@solidjs/router";
import { Loader2 } from "lucide-solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { SessionSearchContextPanel } from "@/features/sessions/session-search-context-panel";
import { HitRow } from "@/features/sessions/session-search-dialog-components";
import { SessionSearchFilters } from "@/features/sessions/session-search-filters";
import { ApiError, getSessionSearchContext, searchSessions } from "@/shared/lib/api";
import type {
  SessionContextMessage,
  SessionSearchContext,
  SessionSearchHit,
  SessionSearchResponse,
  SessionSearchTimeRange,
} from "@/shared/lib/types";
import { useProjectContext } from "@/shared/store/project";

export const SessionSearchDialog: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = (props) => {
  const navigate = useNavigate();
  const project = useProjectContext();
  const [query, setQuery] = createSignal("");
  const [submittedQuery, setSubmittedQuery] = createSignal("");
  const [range, setRange] = createSignal<SessionSearchTimeRange>({
    kind: "relative",
    seconds: 3600,
  });
  const [customFrom, setCustomFrom] = createSignal("");
  const [customTo, setCustomTo] = createSignal("");
  const [result, setResult] = createSignal<{
    data: SessionSearchResponse["data"];
    meta: SessionSearchResponse["meta"];
  } | null>(null);
  const [searchState, setSearchState] = createSignal<"idle" | "loading" | "error">("idle");
  const [error, setError] = createSignal("");
  const [selected, setSelected] = createSignal<SessionSearchHit | null>(null);
  const [context, setContext] = createSignal<SessionSearchContext["data"] | null>(null);
  const [contextMeta, setContextMeta] = createSignal<SessionSearchContext["meta"] | null>(null);
  const [contextState, setContextState] = createSignal<"idle" | "loading" | "error">("idle");
  const [contextError, setContextError] = createSignal("");

  let searchAbort: AbortController | null = null;
  let searchRequest = 0;
  let contextAbort: AbortController | null = null;
  let contextRequest = 0;

  const allHits = createMemo(() => result()?.data.flatMap((group) => group.hits) ?? []);

  createEffect(() => {
    void project()?.projectId;
    const open = props.open;
    searchAbort?.abort();
    contextAbort?.abort();
    searchRequest += 1;
    contextRequest += 1;
    setResult(null);
    setSelected(null);
    setContext(null);
    setContextMeta(null);
    if (!open) {
      setQuery("");
      setSubmittedQuery("");
      setSearchState("idle");
      setContextState("idle");
    }
  });

  onCleanup(() => {
    searchAbort?.abort();
    contextAbort?.abort();
  });

  const submit = async () => {
    const value = query().trim();
    if ([...value].length < 3 || [...value].length > 128) {
      setError("Search text must be 3–128 characters.");
      setSearchState("error");
      return;
    }
    const rawChosen =
      range().kind === "absolute"
        ? {
            kind: "absolute" as const,
            fromTimestamp: customFrom(),
            toTimestamp: customTo(),
          }
        : range();
    if (
      rawChosen.kind === "absolute" &&
      (!rawChosen.fromTimestamp ||
        !rawChosen.toTimestamp ||
        Number.isNaN(new Date(rawChosen.fromTimestamp).getTime()) ||
        Number.isNaN(new Date(rawChosen.toTimestamp).getTime()) ||
        new Date(rawChosen.fromTimestamp) >= new Date(rawChosen.toTimestamp))
    ) {
      setError("Choose a valid start and end time.");
      setSearchState("error");
      return;
    }
    const chosen =
      rawChosen.kind === "absolute"
        ? {
            ...rawChosen,
            fromTimestamp: new Date(rawChosen.fromTimestamp).toISOString(),
            toTimestamp: new Date(rawChosen.toTimestamp).toISOString(),
          }
        : rawChosen;

    searchAbort?.abort();
    contextAbort?.abort();
    contextRequest += 1;
    const controller = new AbortController();
    searchAbort = controller;
    const requestId = ++searchRequest;
    setSelected(null);
    setContext(null);
    setContextMeta(null);
    setSubmittedQuery(value);
    setSearchState("loading");
    setError(" ");
    try {
      const response = await searchSessions(value, chosen, controller.signal);
      if (requestId !== searchRequest) return;
      setResult(response);
      setSearchState("idle");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setSearchState("error");
      setError(err instanceof ApiError ? err.message : "Search failed. Try again.");
    }
  };

  const cancelSearch = () => {
    searchAbort?.abort();
    searchRequest += 1;
    setSearchState("idle");
  };

  const choose = async (hit: SessionSearchHit) => {
    contextAbort?.abort();
    const controller = new AbortController();
    contextAbort = controller;
    const requestId = ++contextRequest;
    setSelected(hit);
    setContext(null);
    setContextState("loading");
    setContextError("");
    try {
      const response = await getSessionSearchContext(
        hit.occurrenceId,
        hit.sourceVersion,
        controller.signal,
        { query: submittedQuery() },
      );
      if (requestId === contextRequest) {
        setContext(response.data);
        setContextMeta(response.meta);
        setContextState("idle");
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (requestId === contextRequest) {
        setContextState("error");
        setContextError(err instanceof ApiError ? err.message : "Preview unavailable.");
      }
    }
  };

  const openFull = () => {
    const hit = selected();
    if (!hit) return;
    const params = new URLSearchParams();
    if (hit.sourceAnchor.traceId) params.set("traceId", hit.sourceAnchor.traceId);
    if (hit.sourceKind === "observation") params.set("observationId", hit.sourceId);
    props.onOpenChange(false);
    navigate(
      `/sessions/${encodeURIComponent(hit.sessionId)}${params.toString() ? `?${params}` : ""}`,
    );
  };

  const loadMore = async (direction: "before" | "after") => {
    const hit = selected();
    const ctx = context();
    const meta = contextMeta();
    if (!hit || !ctx) return;
    const cursor = direction === "before" ? meta?.beforeCursor : meta?.afterCursor;
    if (!cursor) return;
    contextAbort?.abort();
    const controller = new AbortController();
    contextAbort = controller;
    const requestId = ++contextRequest;
    setContextState("loading");
    try {
      const response = await getSessionSearchContext(
        hit.occurrenceId,
        hit.sourceVersion,
        controller.signal,
        { direction, cursor, query: submittedQuery() },
      );
      if (requestId !== contextRequest) return;
      setContext((previous) =>
        previous
          ? {
              ...response.data,
              messages:
                direction === "before"
                  ? [...response.data.messages, ...previous.messages]
                  : [...previous.messages, ...response.data.messages],
            }
          : response.data,
      );
      setContextMeta((previous) =>
        direction === "before"
          ? { ...response.meta, afterCursor: previous?.afterCursor ?? response.meta.afterCursor }
          : {
              ...response.meta,
              beforeCursor: previous?.beforeCursor ?? response.meta.beforeCursor,
            },
      );
      setContextState("idle");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (requestId === contextRequest) {
        setContextState("error");
        setContextError(err instanceof ApiError ? err.message : "Preview unavailable.");
      }
    }
  };

  const loadBlock = async (message: SessionContextMessage, direction: "before" | "after") => {
    const hit = selected();
    if (!hit) return;
    const cursor = direction === "before" ? message.blockBeforeCursor : message.blockCursor;
    if (!cursor) return;
    contextAbort?.abort();
    const controller = new AbortController();
    contextAbort = controller;
    const requestId = ++contextRequest;
    const response = await getSessionSearchContext(
      hit.occurrenceId,
      hit.sourceVersion,
      controller.signal,
      {
        ...(direction === "after" ? { blockCursor: cursor } : { blockBeforeCursor: cursor }),
        query: submittedQuery(),
      },
    );
    if (requestId !== contextRequest) return;
    setContext((previous) => {
      if (!previous) return previous;
      const incoming = response.data.messages.find(
        (candidate) =>
          candidate.occurrenceId === message.occurrenceId ||
          (candidate.field === message.field && candidate.messageOrder === message.messageOrder),
      );
      if (!incoming) return previous;
      return {
        ...previous,
        messages: previous.messages.map((current) => {
          if (
            current.occurrenceId !== incoming.occurrenceId &&
            (current.field !== message.field || current.messageOrder !== message.messageOrder)
          ) {
            return current;
          }
          const mergedBlocks = [...current.blocks, ...incoming.blocks]
            .filter(
              (block, index, blocks) =>
                blocks.findIndex((candidate) => candidate.chunkNo === block.chunkNo) === index,
            )
            .sort((a, b) => a.chunkNo - b.chunkNo);
          return {
            ...current,
            blocks: mergedBlocks,
            blockCursor: direction === "after" ? incoming.blockCursor : current.blockCursor,
            blockBeforeCursor:
              direction === "before" ? incoming.blockBeforeCursor : current.blockBeforeCursor,
            truncated: incoming.truncated,
          };
        }),
      };
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      event.target instanceof HTMLInputElement &&
      event.target.type === "text"
    ) {
      event.preventDefault();
      void submit();
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, select, textarea, button, [role=button]")
    ) {
      return;
    }
    const hits = allHits();
    const current = selected();
    if (event.key === "ArrowDown" && hits.length) {
      event.preventDefault();
      void choose(hits[Math.min((current ? hits.indexOf(current) : -1) + 1, hits.length - 1)]);
    }
    if (event.key === "ArrowUp" && hits.length) {
      event.preventDefault();
      void choose(hits[Math.max((current ? hits.indexOf(current) : hits.length) - 1, 0)]);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        onKeyDown={onKeyDown}
        class="flex h-[80vh] max-h-[800px] max-w-[1200px] flex-col gap-0 overflow-hidden p-0"
        aria-describedby="session-search-description"
      >
        <SessionSearchFilters
          query={query()}
          onQueryChange={setQuery}
          range={range()}
          onRangeChange={setRange}
          customFrom={customFrom()}
          customTo={customTo()}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
          searchState={searchState()}
          error={error()}
          onSubmit={() => void submit()}
          onCancel={cancelSearch}
        />
        <div class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[35%_65%]">
          <section
            class={`${selected() ? "hidden md:flex" : "flex"} min-h-0 flex-col border-r border-border`}
            aria-label="Search results"
          >
            <div class="border-b border-border px-12 py-8 text-xs text-fg-tertiary">
              {result() ? `${result()!.data.length} sessions` : "Results"}
              {result()?.meta.limited && " · Limited results"}
              {result()?.meta.indexState && ` · Index: ${result()!.meta.indexState}`}
              {result()?.meta.coverage !== undefined && ` · Coverage: ${result()!.meta.coverage}`}
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <Show
                when={searchState() !== "loading"}
                fallback={
                  <div class="flex items-center justify-center gap-8 py-48 text-sm text-fg-tertiary">
                    <Loader2 class="h-16 w-16 animate-spin" size={16} />
                    Searching…
                  </div>
                }
              >
                <Show
                  when={result()}
                  fallback={
                    <EmptyState variant="inline" title="Enter at least 3 characters to search." />
                  }
                >
                  {(res) => (
                    <Show
                      when={res().data.length > 0}
                      fallback={<EmptyState variant="inline" title="No sessions found." />}
                    >
                      <For each={res().data}>
                        {(group) => (
                          <div>
                            <div class="sticky top-0 z-[1] border-b border-border bg-surface-raised px-12 py-8 text-xs font-medium">
                              {group.sessionId}
                              {group.userId && (
                                <span class="ml-8 text-fg-tertiary">{group.userId}</span>
                              )}
                            </div>
                            <For each={group.hits.slice(0, 2)}>
                              {(hit) => (
                                <HitRow
                                  hit={hit}
                                  query={submittedQuery()}
                                  selected={selected()?.occurrenceId === hit.occurrenceId}
                                  onClick={() => void choose(hit)}
                                />
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </Show>
                  )}
                </Show>
              </Show>
            </div>
          </section>
          <SessionSearchContextPanel
            selected={selected}
            onClearSelected={() => setSelected(null)}
            contextState={contextState}
            contextError={contextError}
            context={context}
            contextMeta={contextMeta}
            submittedQuery={submittedQuery}
            onRetry={(hit) => void choose(hit)}
            onOpenFull={openFull}
            onLoadBlock={loadBlock}
            onLoadMore={(direction) => loadMore(direction)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
