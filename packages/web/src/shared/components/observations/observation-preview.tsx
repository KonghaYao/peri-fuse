/**
 * Human-readable observation preview for the IoTabs Preview tab.
 */

import { contentToText, extractMessages, isChatPayload, parseMaybeString } from "@peri/ui";
import { ChevronRight } from "lucide-solid";
import { type Component, createMemo, For, Show } from "solid-js";
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

const MessageLine: Component<{ message: ExtractedMessage }> = (props) => {
  const text = () => contentToText(props.message.content);
  const line = () => (props.message.toolCalls ? toolCallsText(props.message.toolCalls) : text());
  return (
    <div class="flex items-baseline gap-6 text-xs">
      <span
        class={cn(
          "w-64 shrink-0 font-mono text-[10px] uppercase",
          ROLE_TEXT[props.message.role] ?? "text-fg-tertiary",
        )}
      >
        {props.message.role}
      </span>
      <span class="min-w-0 truncate text-fg-secondary">{truncate(line(), MAX_MSG_CHARS)}</span>
    </div>
  );
};

const SectionLabel: Component<{ children: string; class?: string }> = (props) => (
  <div
    class={cn(
      "text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary",
      props.class,
    )}
  >
    {props.children}
  </div>
);

const SnippetBlock: Component<{ label: string; value: unknown }> = (props) => {
  const text = () => contentToText(props.value);
  return (
    <div class="space-y-4">
      <SectionLabel>{props.label}</SectionLabel>
      <Show when={text()} fallback={<p class="text-xs text-fg-tertiary">—</p>}>
        <p class="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-secondary">
          {truncate(text(), MAX_SNIPPET_CHARS)}
        </p>
      </Show>
    </div>
  );
};

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

const AnswerBlock: Component<{ answer: AnswerView }> = (props) => {
  const finalIndex = createMemo(() => {
    if (props.answer.kind !== "chat") return null;
    const idx = [...props.answer.messages]
      .reverse()
      .findIndex((m) => !m.toolCalls && contentToText(m.content).trim() !== "");
    return idx === -1 ? null : props.answer.messages.length - 1 - idx;
  });

  if (props.answer.kind === "chat") {
    return (
      <div class="space-y-2">
        <For each={props.answer.messages}>
          {(message, index) => {
            const text = () => contentToText(message.content);
            const isFinal = () => index() === finalIndex();
            return (
              <Show
                when={message.toolCalls}
                fallback={
                  <p
                    class={cn(
                      "whitespace-pre-wrap break-words text-xs leading-relaxed",
                      isFinal() ? "text-fg-secondary" : "text-fg-tertiary",
                    )}
                  >
                    {truncate(text(), MAX_ANSWER_CHARS)}
                  </p>
                }
              >
                <MessageLine message={message} />
              </Show>
            );
          }}
        </For>
      </div>
    );
  }

  return (
    <div class="space-y-4">
      <p class="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-secondary">
        {truncate(props.answer.text, MAX_ANSWER_CHARS)}
      </p>
      <Show when={props.answer.kind === "reasoning" && props.answer.thinking}>
        {(thinking) => (
          <details class="group">
            <summary class="flex cursor-pointer select-none items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary hover:text-fg-secondary [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-12 w-12 transition-transform group-open:rotate-90" size={12} />
              thinking
            </summary>
            <p class="mt-4 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-tertiary">
              {truncate(thinking(), 600)}
            </p>
          </details>
        )}
      </Show>
    </div>
  );
};

export const ObservationPreview: Component<{ observation: Observation }> = (props) => {
  const isGeneration = () => props.observation.type === "GENERATION";
  const messages = createMemo(() =>
    isGeneration() ? extractMessages(parseMaybeString(props.observation.input)) : null,
  );
  const answer = createMemo(() =>
    isGeneration() ? extractAnswer(parseMaybeString(props.observation.output)) : null,
  );
  const model = createMemo(() => {
    const o = props.observation;
    if (o.model) return o.model;
    if (typeof o.input === "object" && o.input !== null) {
      return (o.input as Record<string, unknown>).model as string | undefined;
    }
    return undefined;
  });
  const visibleMessages = createMemo(() => {
    const list = messages();
    return list ? list.slice(-MAX_MESSAGES) : [];
  });
  const hiddenCount = createMemo(() => {
    const list = messages();
    return list ? list.length - visibleMessages().length : 0;
  });

  return (
    <div class="space-y-12">
      <Show when={isGeneration() && (model() || messages())}>
        <div class="space-y-4">
          <SectionLabel>Context</SectionLabel>
          <Show when={model()}>
            <div class="tnum font-mono text-[11px] text-fg-tertiary">model: {model()}</div>
          </Show>
          <Show when={visibleMessages().length > 0}>
            <div class="space-y-2">
              <For each={visibleMessages()}>{(message) => <MessageLine message={message} />}</For>
              <Show when={hiddenCount() > 0}>
                <p class="text-[11px] text-fg-tertiary">… {hiddenCount()} earlier message(s)</p>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={isGeneration()}>
        <div class="space-y-4">
          <SectionLabel class="text-brand">Answer</SectionLabel>
          <Show when={answer()} fallback={<p class="text-xs text-fg-tertiary">—</p>}>
            {(value) => <AnswerBlock answer={value()} />}
          </Show>
        </div>
      </Show>

      <Show when={!isGeneration()}>
        <SnippetBlock label="Input" value={props.observation.input} />
        <SnippetBlock label="Output" value={props.observation.output} />
      </Show>
    </div>
  );
};
