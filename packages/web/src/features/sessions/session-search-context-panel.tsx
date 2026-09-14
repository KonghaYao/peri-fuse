import { Button, EmptyState } from "@peri/ui";
import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Loader2 } from "lucide-solid";
import { type Accessor, type Component, For, Show } from "solid-js";
import { ContextMessage } from "@/features/sessions/session-search-dialog-components";
import type {
  SessionContextMessage,
  SessionSearchContext,
  SessionSearchHit,
} from "@/shared/lib/types";

export const SessionSearchContextPanel: Component<{
  selected: Accessor<SessionSearchHit | null>;
  onClearSelected: () => void;
  contextState: Accessor<"idle" | "loading" | "error">;
  contextError: Accessor<string>;
  context: Accessor<SessionSearchContext["data"] | null>;
  contextMeta: Accessor<SessionSearchContext["meta"] | null>;
  submittedQuery: Accessor<string>;
  onRetry: (hit: SessionSearchHit) => void;
  onOpenFull: () => void;
  onLoadBlock: (message: SessionContextMessage, direction: "before" | "after") => Promise<void>;
  onLoadMore: (direction: "before" | "after") => void;
}> = (props) => (
  <section
    class={`${props.selected() ? "flex" : "hidden md:flex"} min-h-0 flex-col`}
    aria-label="Context preview"
  >
    <Show
      when={props.selected()}
      fallback={<EmptyState variant="inline" title="Select a result to view context." />}
    >
      {(hit) => (
        <>
          <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-sm font-medium">
                <button
                  type="button"
                  class="md:hidden"
                  onClick={props.onClearSelected}
                  aria-label="Back to results"
                >
                  <ArrowLeft class="h-4 w-4" size={16} />
                </button>
                <span class="truncate">{hit().sessionId}</span>
              </div>
              <p class="text-xs text-fg-tertiary">
                {hit().role} · Message {hit().messageOrder + 1}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={props.onOpenFull}>
              <ExternalLink size={16} />
              Open full session
            </Button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <p class="mb-3 text-xs text-fg-tertiary">
              Only user and AI messages are shown. This is a partial preview of the source sequence;
              earlier context may be outside the search time range.
            </p>
            <Show
              when={props.contextState() !== "loading"}
              fallback={
                <div class="flex items-center justify-center gap-2 py-12 text-sm text-fg-tertiary">
                  <Loader2 class="h-4 w-4 animate-spin" size={16} />
                  Loading context…
                </div>
              }
            >
              <Show
                when={props.contextState() !== "error"}
                fallback={
                  <div class="rounded border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
                    {props.contextError()}
                    <Button
                      size="sm"
                      variant="secondary"
                      class="ml-2"
                      onClick={() => props.onRetry(hit())}
                    >
                      Retry
                    </Button>
                  </div>
                }
              >
                <Show
                  when={props.context()}
                  fallback={
                    <EmptyState variant="inline" title="Select a result to view context." />
                  }
                >
                  {(ctx) => (
                    <div class="space-y-2">
                      <For each={ctx().messages}>
                        {(message) => (
                          <ContextMessage
                            message={message}
                            query={props.submittedQuery()}
                            onLoadBlock={props.onLoadBlock}
                          />
                        )}
                      </For>
                      <div class="flex justify-between pt-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!props.contextMeta()?.beforeCursor}
                          onClick={() => props.onLoadMore("before")}
                        >
                          <ChevronUp size={16} />
                          Load earlier messages
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!props.contextMeta()?.afterCursor}
                          onClick={() => props.onLoadMore("after")}
                        >
                          <ChevronDown size={16} />
                          Load later messages
                        </Button>
                      </div>
                      <Show when={props.contextMeta()?.truncated}>
                        <p class="pt-2 text-center text-xs text-fg-tertiary">
                          This preview is incomplete.
                        </p>
                      </Show>
                    </div>
                  )}
                </Show>
              </Show>
            </Show>
          </div>
        </>
      )}
    </Show>
  </section>
);
