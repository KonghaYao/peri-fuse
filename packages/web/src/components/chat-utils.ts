/**
 * Utilities for detecting and normalizing chat-style message payloads
 * (OpenAI / Langfuse SDK conventions) so they can be rendered as a
 * conversation view.
 */

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
    role: m.role as string,
    content: m.content,
    name: typeof m.name === "string" ? m.name : undefined,
    toolCalls: m.tool_calls ?? m.toolCalls,
    toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined,
    raw: m,
  }));
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
