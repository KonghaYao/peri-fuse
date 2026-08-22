/**
 * ObservationPreview — human-readable digest of an observation's input +
 * output, rendered as the "Preview" tab (left of Input/Output).
 *
 * Instead of dumping raw JSON it summarizes:
 * - GENERATION: the model + the chat context (message stream with truncated
 *   bodies and tool-call shorthand) and the assistant answer text.
 * - TOOL / SPAN / AGENT / EVENT: truncated input/output snippets.
 */
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import {
  contentToText,
  extractMessages,
  isChatPayload,
  parseMaybeString,
} from "@/shared/components/chat-utils";
import { truncate } from "@/shared/lib/format";
import type { Observation } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

const MAX_MESSAGES = 10;
const MAX_MSG_CHARS = 140;
const MAX_SNIPPET_CHARS = 260;
const MAX_ANSWER_CHARS = 400;

type ExtractedMessage = NonNullable<ReturnType<typeof extractMessages>>[number];

const ROLE_TEXT: Record<string, string> = {
  system: "text-fg-tertiary",
  user: "text-brand",
  assistant: "text-fg-primary",
  tool: "text-orange-600 dark:text-orange-400",
  function: "text-orange-600 dark:text-orange-400",
};

/** "Read({path: "/x"}) → Write(...)" style shorthand for tool_calls. */
function toolCallsText(calls: unknown): string {
  if (!Array.isArray(calls)) return String(calls ?? "");
  return calls
    .map((call) => {
      const rec = (call ?? {}) as Record<string, unknown>;
      const fn = (rec.function ?? rec) as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : "tool";
      const args =
        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? "");
      return `${name}(${truncate(args, 80)})`;
    })
    .join(" → ");
}

function MessageLine({ message }: { message: ExtractedMessage }) {
  const text = contentToText(message.content);
  const line = message.toolCalls ? toolCallsText(message.toolCalls) : text;
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span
        className={cn(
          "w-16 shrink-0 font-mono text-[10px] uppercase",
          ROLE_TEXT[message.role] ?? "text-fg-tertiary",
        )}
      >
        {message.role}
      </span>
      <span className="min-w-0 truncate text-fg-secondary">{truncate(line, MAX_MSG_CHARS)}</span>
    </div>
  );
}

function SectionLabel({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SnippetBlock({ label, value }: { label: string; value: unknown }) {
  const text = contentToText(value);
  return (
    <div className="space-y-1">
      <SectionLabel>{label}</SectionLabel>
      {text ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-secondary">
          {truncate(text, MAX_SNIPPET_CHARS)}
        </p>
      ) : (
        <p className="text-xs text-fg-tertiary">—</p>
      )}
    </div>
  );
}

/**
 * Answer payload shapes seen in GENERATION outputs:
 * - `{text, thinking}` — reasoning models (deepseek etc.); `thinking` is the
 *   chain-of-thought, `text` the final answer.
 * - chat message arrays — assistant/tool rounds, final answer embedded.
 * - anything else — free text / JSON.
 */
type AnswerView =
  | { kind: "reasoning"; text: string; thinking: string | null }
  | { kind: "chat"; messages: NonNullable<ReturnType<typeof extractMessages>> }
  | { kind: "text"; text: string };

function extractAnswer(output: unknown): AnswerView | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    if (typeof rec.text === "string") {
      return {
        kind: "reasoning",
        text: rec.text,
        thinking: typeof rec.thinking === "string" && rec.thinking ? rec.thinking : null,
      };
    }
  }
  if (isChatPayload(output)) {
    return { kind: "chat", messages: extractMessages(output)! };
  }
  return { kind: "text", text: contentToText(output) };
}

export function ObservationPreview({ observation: o }: { observation: Observation }) {
  const isGeneration = o.type === "GENERATION";

  const messages = useMemo(
    () => (isGeneration ? extractMessages(parseMaybeString(o.input)) : null),
    [o.input, isGeneration],
  );

  function AnswerBlock({ answer }: { answer: AnswerView }) {
    if (answer.kind === "chat") {
      const finalIdx = [...answer.messages]
        .reverse()
        .findIndex((m) => !m.toolCalls && contentToText(m.content).trim() !== "");
      const final = finalIdx === -1 ? null : answer.messages.length - 1 - finalIdx;
      return (
        <div className="space-y-0.5">
          {answer.messages.map((m, i) => {
            const text = contentToText(m.content);
            const isFinal = i === final;
            if (m.toolCalls) return <MessageLine key={i} message={m} />;
            return (
              <p
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-words text-xs leading-relaxed",
                  isFinal ? "text-fg-secondary" : "text-fg-tertiary",
                )}
              >
                {truncate(text, MAX_ANSWER_CHARS)}
              </p>
            );
          })}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-secondary">
          {truncate(answer.text, MAX_ANSWER_CHARS)}
        </p>
        {answer.kind === "reasoning" && answer.thinking && (
          <details className="group">
            <summary className="flex cursor-pointer select-none items-center gap-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary hover:text-fg-secondary [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              thinking
            </summary>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-tertiary">
              {truncate(answer.thinking, 600)}
            </p>
          </details>
        )}
      </div>
    );
  }

  const model =
    o.model ??
    (typeof o.input === "object" && o.input !== null
      ? ((o.input as Record<string, unknown>).model as string | undefined)
      : undefined);

  const answer = useMemo(
    () => (isGeneration ? extractAnswer(parseMaybeString(o.output)) : null),
    [o.output, isGeneration],
  );

  const visible = messages ? messages.slice(-MAX_MESSAGES) : [];
  const hiddenCount = messages ? messages.length - visible.length : 0;

  return (
    <div className="space-y-3">
      {isGeneration && (model || messages) && (
        <div className="space-y-1">
          <SectionLabel>Context</SectionLabel>
          {model && (
            <div className="tnum font-mono text-[11px] text-fg-tertiary">model: {model}</div>
          )}
          {visible.length > 0 && (
            <div className="space-y-0.5">
              {visible.map((m, i) => (
                <MessageLine key={i} message={m} />
              ))}
              {hiddenCount > 0 && (
                <p className="text-[11px] text-fg-tertiary">… {hiddenCount} earlier message(s)</p>
              )}
            </div>
          )}
        </div>
      )}

      {isGeneration && (
        <div className="space-y-1">
          <SectionLabel className="text-brand">Answer</SectionLabel>
          {answer ? <AnswerBlock answer={answer} /> : <p className="text-xs text-fg-tertiary">—</p>}
        </div>
      )}

      {!isGeneration && (
        <>
          <SnippetBlock label="Input" value={o.input} />
          <SnippetBlock label="Output" value={o.output} />
        </>
      )}
    </div>
  );
}
