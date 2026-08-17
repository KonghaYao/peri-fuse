/**
 * Utilities for detecting and normalizing chat-style message payloads
 * (OpenAI / Langfuse SDK conventions) so they can be rendered as a
 * conversation view.
 */
import { truncate } from "@/shared/lib/format";

export type ChatRole = "system" | "user" | "assistant" | "tool" | "function" | "developer";

export type ChatMessage = {
  role: string;
  content: unknown;
  name?: string;
  toolCalls?: unknown;
  toolCallId?: string;
  /** The original raw message object, kept for the JSON inspector dialog. */
  raw: unknown;
};

const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool", "function", "developer"]);

function isMessageLike(item: unknown): item is ChatMessage {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.role !== "string") return false;
  // A message needs content, tool_calls, or at least a recognizable role
  // (assistant messages with tool_calls may omit `content` entirely).
  return "content" in obj || "tool_calls" in obj || "toolCalls" in obj || KNOWN_ROLES.has(obj.role);
}

/**
 * Returns true when `data` looks like a chat completion payload:
 * - `{ messages: [...] }` (most common trace input shape)
 * - a bare array of message objects
 */
export function isChatPayload(data: unknown): boolean {
  if (Array.isArray(data)) {
    return data.length > 0 && data.every(isMessageLike);
  }
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const msgs = obj.messages;
    return Array.isArray(msgs) && msgs.length > 0 && msgs.every(isMessageLike);
  }
  return false;
}

/**
 * Extracts the message array from a chat payload. Returns null when the data
 * is not a recognized chat shape.
 */
export function extractMessages(data: unknown): ChatMessage[] | null {
  if (!isChatPayload(data)) return null;
  const raw = Array.isArray(data) ? data : (data as Record<string, unknown>).messages;
  return (raw as Record<string, unknown>[]).map((m) => ({
    role: normalizeRole(m.role, m.content),
    content: m.content,
    name: typeof m.name === "string" ? m.name : undefined,
    toolCalls: m.tool_calls ?? m.toolCalls,
    toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined,
    raw: m,
  }));
}

/**
 * Anthropic protocol detail: tool results are carried by messages with
 * `role: "user"` whose content is an array of `{type: "tool_result"}` parts.
 * Normalize such messages to the `tool` role so they render as tool-result
 * bubbles (aligned with OpenAI's dedicated `tool` role) instead of user text.
 */
function normalizeRole(role: unknown, content: unknown): string {
  const r = typeof role === "string" ? role.toLowerCase() : "user";
  if (
    r === "user" &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as Record<string, unknown>).type === "tool_result",
    )
  ) {
    return "tool";
  }
  return r;
}

/**
 * Extracts displayable text from message content which may be:
 * - a plain string
 * - an array of content parts ({type:"text", text} / {type:"image_url",...})
 * - an arbitrary object (serialized)
 */
export function contentToText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "image_url") return "[image]";
          if (p.type === "input_audio") return "[audio]";
          // Anthropic-style content parts
          if (p.type === "thinking" && typeof p.thinking === "string") {
            return `[thinking]\n${p.thinking}`;
          }
          if (p.type === "tool_use") {
            const name = typeof p.name === "string" ? p.name : "tool";
            const args = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
            return `[tool_use: ${name}(${truncate(args, 200)})]`;
          }
          if (p.type === "tool_result") {
            return `[tool_result]\n${contentToText(p.content)}`;
          }
          return JSON.stringify(part);
        }
        return String(part);
      })
      .join("\n");
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/**
 * The lite-mode API returns observation input/output as raw JSON strings
 * (only trace-level IO is parsed server-side). Parse defensively so
 * payload-shape detection sees objects; non-JSON stays as-is.
 */
export function parseMaybeString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Normalized content part — one renderable unit inside a message, covering
 * both Anthropic-style content part arrays and OpenAI-style string content
 * plus message-level tool_calls.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; text: string }
  | { type: "image"; url?: string }
  | { type: "audio" }
  | { type: "unknown"; raw: unknown };

/**
 * Flattens a message's content + tool_calls into a uniform part list:
 * - OpenAI shape: string `content` + message-level `tool_calls[]`
 * - Anthropic shape: `content` part array (text / thinking / tool_use /
 *   tool_result / image / audio)
 */
export function extractParts(content: unknown, toolCalls?: unknown): ContentPart[] {
  const parts: ContentPart[] = [];
  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        parts.push({ type: "text", text: part });
        continue;
      }
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      switch (p.type) {
        case "text":
          parts.push({ type: "text", text: typeof p.text === "string" ? p.text : "" });
          break;
        case "thinking":
          parts.push({ type: "thinking", text: typeof p.thinking === "string" ? p.thinking : "" });
          break;
        case "tool_use":
          parts.push({
            type: "tool_use",
            id: typeof p.id === "string" ? p.id : undefined,
            name: typeof p.name === "string" ? p.name : "tool",
            input: p.input,
          });
          break;
        case "tool_result":
          parts.push({
            type: "tool_result",
            id: typeof p.tool_use_id === "string" ? p.tool_use_id : undefined,
            text: contentToText(p.content),
          });
          break;
        case "image_url":
          parts.push({ type: "image", url: imageUrlToString(p.image_url) });
          break;
        case "input_audio":
          parts.push({ type: "audio" });
          break;
        default:
          parts.push({ type: "unknown", raw: part });
      }
    }
  } else if (typeof content === "object" && content !== null) {
    parts.push({ type: "unknown", raw: content });
  }
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (typeof tc !== "object" || tc === null) continue;
      const fn = (tc as Record<string, unknown>).function ?? tc;
      const rec = fn as Record<string, unknown>;
      parts.push({
        type: "tool_use",
        name: typeof rec.name === "string" ? rec.name : "tool",
        input: rec.arguments,
      });
    }
  }
  return parts;
}

function imageUrlToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const url = (value as Record<string, unknown>).url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}

/** Whether the role is one of the well-known chat roles. */
export function isKnownRole(role: string): role is ChatRole {
  return KNOWN_ROLES.has(role);
}

/**
 * Groups consecutive messages sharing the same role into a single visual
 * block — reduces noise when e.g. multiple tool results arrive in a row.
 */
export function groupConsecutive(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    if (last && last[0].role === msg.role) {
      last.push(msg);
    } else {
      groups.push([msg]);
    }
  }
  return groups;
}
