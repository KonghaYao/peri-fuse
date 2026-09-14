import type * as React from "react";
import { useState } from "react";
import type { SessionContextMessage, SessionSearchHit } from "@/shared/lib/types";

export function HighlightedText({
  text,
  ranges,
  query,
}: {
  text: string;
  ranges?: Array<{ start: number; end: number }>;
  query: string;
}) {
  const safe =
    ranges?.filter((r) => r.start >= 0 && r.end > r.start && r.start < text.length) ?? [];
  if (!safe.length && query) {
    const start = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (start >= 0) safe.push({ start, end: start + query.length });
  }
  if (!safe.length) return <>{text}</>;
  const pieces: React.ReactNode[] = [];
  let at = 0;
  safe
    .sort((a, b) => a.start - b.start)
    .forEach((range, index) => {
      const start = Math.max(at, range.start);
      const end = Math.min(text.length, range.end);
      if (start > at) pieces.push(<span key={`text-${index}`}>{text.slice(at, start)}</span>);
      if (end > start)
        pieces.push(
          <mark key={`hit-${index}`} className="rounded bg-warning/30 px-0.5">
            {text.slice(start, end)}
          </mark>,
        );
      at = Math.max(at, end);
    });
  if (at < text.length) pieces.push(<span key="tail">{text.slice(at)}</span>);
  return <>{pieces}</>;
}

export function HitRow({
  hit,
  query,
  selected,
  onClick,
}: {
  hit: SessionSearchHit;
  query: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-b border-border px-3 py-3 text-left transition-colors ${selected ? "bg-surface-overlay" : "hover:bg-surface-overlay/60"}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-fg-tertiary">
        <span className="font-medium uppercase">{hit.role}</span>
        <span>
          {new Date(hit.recordTime).toLocaleString()} · Message {hit.messageOrder + 1}
        </span>
      </div>
      <p className="line-clamp-3 text-sm text-fg-primary">
        <HighlightedText text={hit.snippet} ranges={hit.highlight} query={query} />
      </p>
    </button>
  );
}

export function ContextMessage({
  message,
  query,
  onLoadBlock,
}: {
  message: SessionContextMessage;
  query: string;
  onLoadBlock: (message: SessionContextMessage, direction: "before" | "after") => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loadingBlock, setLoadingBlock] = useState(false);
  const [blockError, setBlockError] = useState(false);
  const long = message.truncated || message.text.length > 2048;
  const hasEarlierBlocks = Boolean(message.blockBeforeCursor);
  const hasLaterBlocks = Boolean(message.blockCursor);
  const visibleBlocks = message.blocks;
  const text = expanded || !long ? message.text : `${message.text.slice(0, 2048)}…`;
  const expand = () => setExpanded((value) => !value);
  return (
    <div
      className={`rounded-md border p-3 ${message.role === "user" ? "border-brand/20 bg-brand/5" : "border-border bg-surface-raised"}`}
    >
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase text-fg-tertiary">
        <span>{message.role}</span>
        {message.messageOrder !== undefined && <span>Message {message.messageOrder + 1}</span>}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-fg-primary">
        {message.blocks.length > 0 ? (
          visibleBlocks.map((block) => (
            <span key={block.chunkNo}>
              <HighlightedText text={block.text} ranges={block.highlight} query={query} />
            </span>
          ))
        ) : (
          <HighlightedText text={text} ranges={message.highlight} query={query} />
        )}
      </p>
      {blockError && (
        <p className="mt-2 text-xs text-danger">Could not load the rest of this message.</p>
      )}
      {long && !message.blocks.length && (
        <button
          type="button"
          className="mt-2 text-xs text-brand hover:underline"
          onClick={() => void expand()}
          disabled={loadingBlock}
        >
          {loadingBlock ? "Loading message…" : expanded ? "Collapse message" : "Expand message"}
        </button>
      )}
      {(hasEarlierBlocks || hasLaterBlocks) && (
        <div className="mt-2 flex gap-3 text-xs text-brand">
          {hasEarlierBlocks && (
            <button
              type="button"
              className="hover:underline"
              onClick={() => {
                setLoadingBlock(true);
                setBlockError(false);
                void onLoadBlock(message, "before")
                  .catch(() => setBlockError(true))
                  .finally(() => setLoadingBlock(false));
              }}
              disabled={loadingBlock}
            >
              {loadingBlock ? "Loading message…" : "Load earlier text"}
            </button>
          )}
          {hasLaterBlocks && (
            <button
              type="button"
              className="hover:underline"
              onClick={() => {
                setLoadingBlock(true);
                setBlockError(false);
                void onLoadBlock(message, "after")
                  .catch(() => setBlockError(true))
                  .finally(() => setLoadingBlock(false));
              }}
              disabled={loadingBlock}
            >
              {loadingBlock ? "Loading message…" : "Load later text"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
