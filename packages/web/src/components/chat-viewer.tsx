/**
 * ChatViewer — renders a chat-style message list as a conversation UI.
 *
 * Design highlights:
 * - Role-differentiated bubbles (system / user / assistant / tool)
 * - Consecutive same-role messages grouped into one visual block
 * - Progressive disclosure for long conversations: only the most recent N
 *   messages render initially; a "load earlier" button prepends older ones
 * - Long message bodies truncate with an expand toggle
 */
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  History,
  Settings,
  SquareTerminal,
  User,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { type ChatMessage, contentToText, groupConsecutive } from "@/components/chat-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Messages rendered initially (from the end of the conversation). */
const INITIAL_VISIBLE = 20;
/** Additional messages loaded per "show earlier" click. */
const LOAD_STEP = 50;
/** Character threshold beyond which a message body is truncated. */
const TRUNCATE_CHARS = 1200;

// ---------------------------------------------------------------------------
// Role presentation config
// ---------------------------------------------------------------------------

type RoleConfig = {
  label: string;
  icon: typeof User;
  /** Bubble + accent classes */
  bubble: string;
  iconWrap: string;
  /** Whether the bubble aligns to the right (user messages) */
  alignRight?: boolean;
  /** System messages start collapsed */
  defaultCollapsed?: boolean;
  /** Render content in monospace (tool results) */
  mono?: boolean;
};

const ROLE_CONFIG: Record<string, RoleConfig> = {
  system: {
    label: "System",
    icon: Settings,
    bubble: "border-amber-500/25 bg-amber-500/[0.06]",
    iconWrap: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    defaultCollapsed: true,
  },
  developer: {
    label: "Developer",
    icon: Settings,
    bubble: "border-amber-500/25 bg-amber-500/[0.06]",
    iconWrap: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    defaultCollapsed: true,
  },
  user: {
    label: "User",
    icon: User,
    bubble: "border-blue-500/25 bg-blue-500/[0.07]",
    iconWrap: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    alignRight: true,
  },
  assistant: {
    label: "Assistant",
    icon: Bot,
    bubble: "border-violet-500/25 bg-violet-500/[0.06]",
    iconWrap: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  tool: {
    label: "Tool",
    icon: SquareTerminal,
    bubble: "border-emerald-500/25 bg-emerald-500/[0.06]",
    iconWrap: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    mono: true,
  },
  function: {
    label: "Function",
    icon: SquareTerminal,
    bubble: "border-emerald-500/25 bg-emerald-500/[0.06]",
    iconWrap: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    mono: true,
  },
};

const FALLBACK_ROLE: RoleConfig = {
  label: "",
  icon: Bot,
  bubble: "border-border bg-muted/40",
  iconWrap: "bg-muted text-muted-foreground",
};

function roleConfig(role: string): RoleConfig {
  const cfg = ROLE_CONFIG[role];
  if (cfg) return cfg;
  return { ...FALLBACK_ROLE, label: role };
}

// ---------------------------------------------------------------------------
// Message content block (with truncation for long bodies)
// ---------------------------------------------------------------------------

function MessageBody({ text, mono }: { text: string; mono?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > TRUNCATE_CHARS;
  const display = needsTruncation && !expanded ? `${text.slice(0, TRUNCATE_CHARS)}…` : text;

  return (
    <div>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words text-xs leading-relaxed",
          mono ? "font-mono" : "font-sans",
          !expanded && needsTruncation && "line-clamp-none",
        )}
      >
        {display}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Show more ({(text.length / 1000).toFixed(1)}k
              chars)
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw JSON inspector dialog (per-message)
// ---------------------------------------------------------------------------

function MessageJsonDialog({ message, index }: { message: ChatMessage; index: number }) {
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(message.raw, null, 2);
    } catch {
      return String(message.raw);
    }
  }, [message.raw]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  }, [json]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title="View raw JSON"
          aria-label="View raw JSON"
          className="inline-flex items-center gap-0.5 rounded border border-border/70 bg-muted/40 px-1 py-px font-mono text-[9px] font-semibold text-muted-foreground opacity-0 transition-all hover:border-border hover:bg-muted hover:text-foreground group-hover:opacity-100"
        >
          {"{}"}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Message #{index} · {message.role}
          </DialogTitle>
          <DialogDescription className="text-xs">Raw message payload</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
            {json}
          </pre>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              copied
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy JSON
              </>
            )}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Single message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ message, index }: { message: ChatMessage; index: number }) {
  const cfg = roleConfig(message.role);
  const Icon = cfg.icon;
  const text = contentToText(message.content);
  const [collapsed, setCollapsed] = useState(cfg.defaultCollapsed ?? false);

  const label = cfg.label || message.role;
  const nameSuffix = message.name ? ` · ${message.name}` : "";
  const toolSuffix = message.toolCallId ? ` · ${message.toolCallId.slice(0, 12)}…` : "";

  return (
    <div className={cn("group flex gap-2.5", cfg.alignRight && "flex-row-reverse")}>
      {/* Avatar */}
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          cfg.iconWrap,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>

      {/* Bubble */}
      <div
        className={cn("min-w-0 max-w-[85%] flex-1", cfg.alignRight && "flex flex-col items-end")}
      >
        {/* Role label row */}
        <div
          className={cn(
            "mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground",
            cfg.alignRight && "flex-row-reverse",
          )}
        >
          <span className="font-semibold uppercase tracking-wide">{label}</span>
          {(message.name || message.toolCallId) && (
            <span className="truncate font-mono text-[10px] opacity-70">
              {nameSuffix}
              {toolSuffix}
            </span>
          )}
          <span className="font-mono text-[10px] opacity-50">#{index}</span>
          <MessageJsonDialog message={message} index={index} />
          {cfg.defaultCollapsed && (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="rounded px-1 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
            >
              {collapsed ? "expand" : "collapse"}
            </button>
          )}
        </div>

        {/* Content */}
        {!collapsed ? (
          <div className={cn("rounded-lg border px-3 py-2", cfg.bubble)}>
            {text ? (
              <MessageBody text={text} mono={cfg.mono} />
            ) : (
              <span className="text-xs italic text-muted-foreground">(empty)</span>
            )}
            {/* Tool calls attached to an assistant message */}
            {Boolean(message.toolCalls) && (
              <div className="mt-2 border-t border-border/60 pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Tool calls
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(message.toolCalls, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className={cn(
              "w-full cursor-pointer rounded-lg border border-dashed px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:border-solid hover:text-foreground",
              cfg.bubble,
            )}
          >
            {text ? `${text.slice(0, 80)}${text.length > 80 ? "…" : ""}` : "(empty)"}
            <span className="ml-2 font-medium">— click to expand</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group of consecutive same-role messages
// ---------------------------------------------------------------------------

function MessageGroup({ messages, startIndex }: { messages: ChatMessage[]; startIndex: number }) {
  const cfg = roleConfig(messages[0].role);
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 1) {
    return <MessageBubble message={messages[0]} index={startIndex + 1} />;
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-solid hover:bg-muted/40 hover:text-foreground"
      >
        <span className={cn("flex h-4 w-4 items-center justify-center rounded", cfg.iconWrap)}>
          <cfg.icon className="h-2.5 w-2.5" />
        </span>
        <span className="font-medium">
          {messages.length} consecutive {cfg.label || messages[0].role} messages
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border/60 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {messages.length} × {cfg.label || messages[0].role}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          collapse <ChevronUp className="h-3 w-3" />
        </button>
      </div>
      {messages.map((msg, i) => (
        <MessageBubble key={`${startIndex + i}`} message={msg} index={startIndex + i + 1} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ChatViewer
// ---------------------------------------------------------------------------

export function ChatViewer({ messages }: { messages: ChatMessage[] }) {
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(INITIAL_VISIBLE, messages.length),
  );

  const visible = useMemo(
    () => messages.slice(messages.length - visibleCount),
    [messages, visibleCount],
  );

  const groups = useMemo(() => groupConsecutive(visible), [visible]);

  // Compute the starting index (in the full list) of each group.
  const groupStartIndices = useMemo(() => {
    const indices: number[] = [];
    let cursor = messages.length - visibleCount;
    for (const g of groups) {
      indices.push(cursor);
      cursor += g.length;
    }
    return indices;
  }, [groups, messages.length, visibleCount]);

  const hiddenCount = messages.length - visibleCount;

  const loadEarlier = useCallback(() => {
    setVisibleCount((c) => Math.min(c + LOAD_STEP, messages.length));
  }, [messages.length]);

  return (
    <div className="rounded-md border border-border bg-muted/10">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {messages.length} messages
        </span>
        {hiddenCount > 0 && (
          <span className="text-[10px] text-muted-foreground/70">
            showing latest {visibleCount}
          </span>
        )}
      </div>

      <div className="space-y-3 p-3">
        {/* Load-earlier button */}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={loadEarlier}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-solid hover:bg-muted/50 hover:text-foreground"
          >
            <History className="h-3.5 w-3.5" />
            Load {Math.min(LOAD_STEP, hiddenCount)} earlier messages
            <span className="text-[10px] opacity-60">({hiddenCount} hidden)</span>
          </button>
        )}

        {/* Message groups */}
        {groups.map((group, gi) => (
          <MessageGroup
            key={`${groupStartIndices[gi]}`}
            messages={group}
            startIndex={groupStartIndices[gi]}
          />
        ))}
      </div>
    </div>
  );
}
