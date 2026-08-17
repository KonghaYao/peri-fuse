/**
 * Structured renderers for normalized chat content parts (see `extractParts`
 * in chat-utils) — text with truncation, collapsible thinking blocks, and
 * tool-call / tool-result cards. Used by ChatViewer so that Anthropic-style
 * content parts and OpenAI-style tool_calls render as UI instead of raw JSON.
 */
import { ChevronDown, Sparkles, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import type { ContentPart } from "@/shared/components/chat-utils";
import { cn } from "@/shared/lib/utils";

/** Character threshold beyond which a text body is truncated. */
const TRUNCATE_CHARS = 1200;

/**
 * Message text body with truncation + expand toggle. `mono` renders tool
 * results in monospace.
 */
export function MessageBody({ text, mono }: { text: string; mono?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > TRUNCATE_CHARS;
  const display = needsTruncation && !expanded ? `${text.slice(0, TRUNCATE_CHARS)}…` : text;

  return (
    <div>
      <pre
        className={cn(
          "w-full whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground",
          mono ? "font-mono text-[11px] text-muted-foreground" : "font-sans",
          !expanded && needsTruncation && "line-clamp-none",
        )}
      >
        {display}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more…"}
        </button>
      )}
    </div>
  );
}

/** Collapsible chain-of-thought block (Anthropic `thinking` parts). */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-violet-500/20 bg-violet-500/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left"
      >
        <Sparkles className="h-3 w-3 text-violet-500" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
          thinking
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3 w-3 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-violet-500/15 px-2 py-1.5">
          <MessageBody text={text} />
        </div>
      )}
    </div>
  );
}

/** Collapsible tool-call card (Anthropic `tool_use` / OpenAI `tool_calls`). */
function ToolUseBlock({ id, name, input }: { id?: string; name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const json = useMemo(
    () => (typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2)),
    [input],
  );
  return (
    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left"
      >
        <SquareTerminal className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        <span className="font-mono text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          {name}
        </span>
        {id && <span className="truncate font-mono text-[10px] opacity-50">{id}</span>}
        <ChevronDown
          className={cn(
            "ml-auto h-3 w-3 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-emerald-500/15 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {json}
        </pre>
      )}
    </div>
  );
}

/** Tool result body — monospace text, with the matching tool-call id when known. */
function ToolResultBlock({ id, text }: { id?: string; text: string }) {
  return (
    <div>
      {id && <div className="mb-0.5 font-mono text-[10px] text-muted-foreground/70">↳ {id}</div>}
      <MessageBody text={text} mono />
    </div>
  );
}

/** Renders one normalized content part inside a message bubble. */
export function PartView({ part, mono }: { part: ContentPart; mono?: boolean }) {
  switch (part.type) {
    case "text":
      return part.text ? <MessageBody text={part.text} mono={mono} /> : null;
    case "thinking":
      return part.text ? <ThinkingBlock text={part.text} /> : null;
    case "tool_use":
      return <ToolUseBlock id={part.id} name={part.name} input={part.input} />;
    case "tool_result":
      return part.text ? <ToolResultBlock id={part.id} text={part.text} /> : null;
    case "image":
      return part.url ? (
        <img
          src={part.url}
          alt="message image"
          className="max-h-40 rounded-md border border-border"
        />
      ) : (
        <span className="text-[11px] italic text-muted-foreground">[image]</span>
      );
    case "audio":
      return <span className="text-[11px] italic text-muted-foreground">[audio]</span>;
    default:
      return <MessageBody text={JSON.stringify(part.raw, null, 2)} mono />;
  }
}
