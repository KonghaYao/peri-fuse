import { type Component, createSignal, For, type JSX } from "solid-js";
import type { SessionContextMessage, SessionSearchHit } from "@/shared/lib/types";

export function HighlightedText(props: {
  text: string;
  ranges?: Array<{ start: number; end: number }>;
  query: string;
}): JSX.Element {
  const safe =
    props.ranges?.filter((r) => r.start >= 0 && r.end > r.start && r.start < props.text.length) ??
    [];
  if (!safe.length && props.query) {
    const start = props.text.toLocaleLowerCase().indexOf(props.query.toLocaleLowerCase());
    if (start >= 0) safe.push({ start, end: start + props.query.length });
  }
  if (!safe.length) return <>{props.text}</>;
  const pieces: JSX.Element[] = [];
  let at = 0;
  safe
    .sort((a, b) => a.start - b.start)
    .forEach((range, index) => {
      const start = Math.max(at, range.start);
      const end = Math.min(props.text.length, range.end);
      if (start > at) pieces.push(<span>{props.text.slice(at, start)}</span>);
      if (end > start) {
        pieces.push(
          <mark class="rounded bg-warning/30 px-0.5">{props.text.slice(start, end)}</mark>,
        );
      }
      at = Math.max(at, end);
    });
  if (at < props.text.length) pieces.push(<span>{props.text.slice(at)}</span>);
  return <>{pieces}</>;
}

export const HitRow: Component<{
  hit: SessionSearchHit;
  query: string;
  selected: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class={`w-full border-b border-border px-3 py-3 text-left transition-colors ${props.selected ? "bg-surface-overlay" : "hover:bg-surface-overlay/60"}`}
  >
    <div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-fg-tertiary">
      <span class="font-medium uppercase">{props.hit.role}</span>
      <span>
        {new Date(props.hit.recordTime).toLocaleString()} · Message {props.hit.messageOrder + 1}
      </span>
    </div>
    <p class="line-clamp-3 text-sm text-fg-primary">
      <HighlightedText text={props.hit.snippet} ranges={props.hit.highlight} query={props.query} />
    </p>
  </button>
);

export const ContextMessage: Component<{
  message: SessionContextMessage;
  query: string;
  onLoadBlock: (message: SessionContextMessage, direction: "before" | "after") => Promise<void>;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [loadingBlock, setLoadingBlock] = createSignal(false);
  const [blockError, setBlockError] = createSignal(false);
  const long = () => props.message.truncated || props.message.text.length > 2048;
  const hasEarlierBlocks = () => Boolean(props.message.blockBeforeCursor);
  const hasLaterBlocks = () => Boolean(props.message.blockCursor);
  const text = () =>
    expanded() || !long() ? props.message.text : `${props.message.text.slice(0, 2048)}…`;

  return (
    <div
      class={`rounded-md border p-3 ${props.message.role === "user" ? "border-brand/20 bg-brand/5" : "border-border bg-surface-raised"}`}
    >
      <div class="mb-1 flex items-center justify-between text-[11px] font-medium uppercase text-fg-tertiary">
        <span>{props.message.role}</span>
        {props.message.messageOrder !== undefined && (
          <span>Message {props.message.messageOrder + 1}</span>
        )}
      </div>
      <p class="whitespace-pre-wrap break-words text-sm text-fg-primary">
        {props.message.blocks.length > 0 ? (
          <For each={props.message.blocks}>
            {(block) => (
              <span>
                <HighlightedText text={block.text} ranges={block.highlight} query={props.query} />
              </span>
            )}
          </For>
        ) : (
          <HighlightedText text={text()} ranges={props.message.highlight} query={props.query} />
        )}
      </p>
      {blockError() && (
        <p class="mt-2 text-xs text-danger">Could not load the rest of this message.</p>
      )}
      {long() && props.message.blocks.length === 0 && (
        <button
          type="button"
          class="mt-2 text-xs text-brand hover:underline"
          onClick={() => setExpanded((value) => !value)}
          disabled={loadingBlock()}
        >
          {loadingBlock() ? "Loading message…" : expanded() ? "Collapse message" : "Expand message"}
        </button>
      )}
      {(hasEarlierBlocks() || hasLaterBlocks()) && (
        <div class="mt-2 flex gap-3 text-xs text-brand">
          {hasEarlierBlocks() && (
            <button
              type="button"
              class="hover:underline"
              onClick={() => {
                setLoadingBlock(true);
                setBlockError(false);
                void props
                  .onLoadBlock(props.message, "before")
                  .catch(() => setBlockError(true))
                  .finally(() => setLoadingBlock(false));
              }}
              disabled={loadingBlock()}
            >
              {loadingBlock() ? "Loading message…" : "Load earlier text"}
            </button>
          )}
          {hasLaterBlocks() && (
            <button
              type="button"
              class="hover:underline"
              onClick={() => {
                setLoadingBlock(true);
                setBlockError(false);
                void props
                  .onLoadBlock(props.message, "after")
                  .catch(() => setBlockError(true))
                  .finally(() => setLoadingBlock(false));
              }}
              disabled={loadingBlock()}
            >
              {loadingBlock() ? "Loading message…" : "Load later text"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
