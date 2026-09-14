import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Loader2 } from "lucide-react";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/shared/components/state";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent } from "@/shared/components/ui/dialog";
import { ApiError, getSessionSearchContext, searchSessions } from "@/shared/lib/api";
import type {
  SessionContextMessage,
  SessionSearchContext,
  SessionSearchGroup,
  SessionSearchHit,
  SessionSearchResponse,
  SessionSearchTimeRange,
} from "@/shared/lib/types";
import { useProjectContext } from "@/shared/store/project";
import { ContextMessage, HitRow } from "./session-search-dialog-components";
import { SessionSearchFilters } from "./session-search-filters";

export function SessionSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const project = useProjectContext();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [range, setRange] = useState<SessionSearchTimeRange>({ kind: "relative", seconds: 3600 });
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [result, setResult] = useState<{
    data: SessionSearchGroup[];
    meta: SessionSearchResponse["meta"];
  } | null>(null);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SessionSearchHit | null>(null);
  const [context, setContext] = useState<SessionSearchContext["data"] | null>(null);
  const [contextMeta, setContextMeta] = useState<SessionSearchContext["meta"] | null>(null);
  const [contextState, setContextState] = useState<"idle" | "loading" | "error">("idle");
  const [contextError, setContextError] = useState("");
  const searchAbort = useRef<AbortController | null>(null);
  const searchRequest = useRef(0);
  const contextAbort = useRef<AbortController | null>(null);
  const contextRequest = useRef(0);
  const entryRef = useRef<HTMLButtonElement>(null);
  const allHits = useMemo(() => result?.data.flatMap((group) => group.hits) ?? [], [result]);

  useEffect(() => {
    void project?.projectId;
    searchAbort.current?.abort();
    contextAbort.current?.abort();
    searchRequest.current += 1;
    contextRequest.current += 1;
    setResult(null);
    setSelected(null);
    setContext(null);
    setContextMeta(null);
    if (!open) {
      setQuery("");
      setSubmittedQuery("");
      setSearchState("idle");
      setContextState("idle");
      entryRef.current?.focus();
    }
    return () => {
      searchAbort.current?.abort();
      contextAbort.current?.abort();
    };
  }, [open, project?.projectId]);

  const submit = async () => {
    const value = query.trim();
    if ([...value].length < 3 || [...value].length > 128) {
      setError("Search text must be 3–128 characters.");
      setSearchState("error");
      return;
    }
    const rawChosen =
      range.kind === "absolute"
        ? ({
            kind: "absolute",
            fromTimestamp: customFrom,
            toTimestamp: customTo,
          } as const)
        : range;
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
    searchAbort.current?.abort();
    contextAbort.current?.abort();
    contextRequest.current += 1;
    const controller = new AbortController();
    searchAbort.current = controller;
    const requestId = ++searchRequest.current;
    setSelected(null);
    setContext(null);
    setContextMeta(null);
    setSubmittedQuery(value);
    setSearchState("loading");
    setError(" ");
    try {
      const response = await searchSessions(value, chosen, controller.signal);
      if (requestId !== searchRequest.current) return;
      setResult(response);
      setSearchState("idle");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setSearchState("error");
      setError(err instanceof ApiError ? err.message : "Search failed. Try again.");
    }
  };
  const cancelSearch = () => {
    searchAbort.current?.abort();
    searchRequest.current += 1;
    setSearchState("idle");
  };

  const choose = async (hit: SessionSearchHit) => {
    contextAbort.current?.abort();
    contextRequest.current += 1;
    const controller = new AbortController();
    contextAbort.current = controller;
    const requestId = ++contextRequest.current;
    setSelected(hit);
    setContext(null);
    setContextState("loading");
    setContextError("");
    try {
      const response = await getSessionSearchContext(
        hit.occurrenceId,
        hit.sourceVersion,
        controller.signal,
        { query: submittedQuery },
      );
      if (requestId === contextRequest.current) {
        setContext(response.data);
        setContextMeta(response.meta);
        setContextState("idle");
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (requestId === contextRequest.current) {
        setContextState("error");
        setContextError(err instanceof ApiError ? err.message : "Preview unavailable.");
      }
    }
  };

  const openFull = () => {
    if (!selected) return;
    const params = new URLSearchParams();
    if (selected.sourceAnchor.traceId) params.set("traceId", selected.sourceAnchor.traceId);
    if (selected.sourceKind === "observation") params.set("observationId", selected.sourceId);
    onOpenChange(false);
    navigate(
      `/sessions/${encodeURIComponent(selected.sessionId)}${params.toString() ? `?${params}` : ""}`,
    );
  };
  const loadMore = async (direction: "before" | "after") => {
    if (!selected || !context) return;
    const cursor = direction === "before" ? contextMeta?.beforeCursor : contextMeta?.afterCursor;
    if (!cursor) return;
    contextAbort.current?.abort();
    const controller = new AbortController();
    contextAbort.current = controller;
    const requestId = ++contextRequest.current;
    setContextState("loading");
    try {
      const response = await getSessionSearchContext(
        selected.occurrenceId,
        selected.sourceVersion,
        controller.signal,
        { direction, cursor, query: submittedQuery },
      );
      if (requestId !== contextRequest.current) return;
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
      if (requestId === contextRequest.current) {
        setContextState("error");
        setContextError(err instanceof ApiError ? err.message : "Preview unavailable.");
      }
    }
  };
  const loadBlock = async (message: SessionContextMessage, direction: "before" | "after") => {
    if (!selected) return;
    const cursor = direction === "before" ? message.blockBeforeCursor : message.blockCursor;
    if (!cursor) return;
    contextAbort.current?.abort();
    const controller = new AbortController();
    contextAbort.current = controller;
    const requestId = ++contextRequest.current;
    const response = await getSessionSearchContext(
      selected.occurrenceId,
      selected.sourceVersion,
      controller.signal,
      {
        ...(direction === "after" ? { blockCursor: cursor } : { blockBeforeCursor: cursor }),
        query: submittedQuery,
      },
    );
    if (requestId !== contextRequest.current) return;
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
  const onKeyDown = (event: React.KeyboardEvent) => {
    // Keep native controls' segmented editing and selection behavior intact.
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
    if (event.key === "ArrowDown" && allHits.length) {
      event.preventDefault();
      void choose(
        allHits[Math.min((selected ? allHits.indexOf(selected) : -1) + 1, allHits.length - 1)],
      );
    }
    if (event.key === "ArrowUp" && allHits.length) {
      event.preventDefault();
      void choose(
        allHits[Math.max((selected ? allHits.indexOf(selected) : allHits.length) - 1, 0)],
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={onKeyDown}
        className="flex h-[80vh] max-h-[800px] max-w-[1200px] flex-col gap-0 overflow-hidden p-0"
        aria-describedby="session-search-description"
      >
        <SessionSearchFilters
          query={query}
          onQueryChange={setQuery}
          range={range}
          onRangeChange={setRange}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
          searchState={searchState}
          error={error}
          onSubmit={() => void submit()}
          onCancel={cancelSearch}
        />
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[35%_65%]">
          <section
            className={`${selected ? "hidden md:flex" : "flex"} min-h-0 flex-col border-r border-border`}
            aria-label="Search results"
          >
            <div className="border-b border-border px-3 py-2 text-xs text-fg-tertiary">
              {result ? `${result.data.length} sessions` : "Results"}
              {result?.meta.limited && " · Limited results"}
              {result?.meta.indexState && ` · Index: ${result.meta.indexState}`}
              {result?.meta.coverage !== undefined && ` · Coverage: ${result.meta.coverage}`}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {searchState === "loading" ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-tertiary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Searching…
                </div>
              ) : result && result.data.length === 0 ? (
                <EmptyState message="No sessions found." />
              ) : !result ? (
                <EmptyState message="Enter at least 3 characters to search." />
              ) : (
                result.data.map((group) => (
                  <div key={group.sessionId}>
                    <div className="sticky top-0 z-[1] border-b border-border bg-surface-raised px-3 py-2 text-xs font-medium">
                      {group.sessionId}
                      {group.userId && (
                        <span className="ml-2 text-fg-tertiary">{group.userId}</span>
                      )}
                    </div>
                    {group.hits.slice(0, 2).map((hit) => (
                      <HitRow
                        key={hit.occurrenceId}
                        hit={hit}
                        query={submittedQuery}
                        selected={selected?.occurrenceId === hit.occurrenceId}
                        onClick={() => void choose(hit)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </section>
          <section
            className={`${selected ? "flex" : "hidden md:flex"} min-h-0 flex-col`}
            aria-label="Context preview"
          >
            {selected ? (
              <>
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <button
                        type="button"
                        className="md:hidden"
                        onClick={() => setSelected(null)}
                        aria-label="Back to results"
                      >
                        <ArrowLeft className="h-4 w-4" />
                      </button>
                      <span className="truncate">{selected.sessionId}</span>
                    </div>
                    <p className="text-xs text-fg-tertiary">
                      {selected.role} · Message {selected.messageOrder + 1}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={openFull}>
                    <ExternalLink />
                    Open full session
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <p className="mb-3 text-xs text-fg-tertiary">
                    Only user and AI messages are shown. This is a partial preview of the source
                    sequence; earlier context may be outside the search time range.
                  </p>
                  {contextState === "loading" ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-tertiary">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading context…
                    </div>
                  ) : contextState === "error" ? (
                    <div className="rounded border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
                      {contextError}
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-2"
                        onClick={() => void choose(selected)}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : context ? (
                    <div className="space-y-2">
                      {context.messages.map((message, index) => (
                        <ContextMessage
                          key={`${message.occurrenceId}-${message.messageOrder ?? index}`}
                          message={message}
                          query={submittedQuery}
                          onLoadBlock={loadBlock}
                        />
                      ))}
                      <div className="flex justify-between pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!contextMeta?.beforeCursor}
                          onClick={() => void loadMore("before")}
                        >
                          <ChevronUp />
                          Load earlier messages
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!contextMeta?.afterCursor}
                          onClick={() => void loadMore("after")}
                        >
                          <ChevronDown />
                          Load later messages
                        </Button>
                      </div>
                      {contextMeta?.truncated && (
                        <p className="pt-2 text-center text-xs text-fg-tertiary">
                          This preview is incomplete.
                        </p>
                      )}
                    </div>
                  ) : (
                    <EmptyState message="Select a result to view context." />
                  )}
                </div>
              </>
            ) : (
              <EmptyState message="Select a result to view context." />
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
