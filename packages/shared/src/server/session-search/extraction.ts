import { createHash } from "node:crypto";

export type SearchRole = "user" | "assistant";
export type ExtractedMessage = { role: SearchRole; text: string; field: string; order: number };
export type TextChunk = { text: string; chunkNo: number; start: number; end: number };
const CHUNK_BYTES = 4096;
const OVERLAP = 127;

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}
function stringContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else if (
      item &&
      typeof item === "object" &&
      ["text", "input_text", "output_text"].includes(String((item as { type?: string }).type))
    ) {
      const t = (item as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length ? parts.join("\n") : null;
}
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Extract only protocol structures that explicitly identify visible user/assistant text. */
export function extractMessages(
  input: unknown,
  output: unknown,
  type?: string,
): ExtractedMessage[] {
  const result: ExtractedMessage[] = [];
  const add = (role: SearchRole, text: string | null, field: string) => {
    if (text?.trim()) result.push({ role, text, field, order: result.length });
  };
  const walk = (value: unknown, field: string) => {
    const v = parse(value);
    const list = Array.isArray(v)
      ? v
      : v && typeof v === "object"
        ? ((v as Record<string, unknown>).messages ?? (v as Record<string, unknown>).choices)
        : null;
    if (!Array.isArray(list) || !list.length) return;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const role = record.role;
      if (role === "user" || role === "assistant")
        add(role, stringContent(record.content ?? record.text), field);
      else if (record.message && typeof record.message === "object") {
        const message = record.message as Record<string, unknown>;
        if (message.role === "user" || message.role === "assistant")
          add(message.role, stringContent(message.content ?? message.text), `${field}.message`);
      }
    }
  };
  walk(input, "input.messages");
  walk(output, "output.messages");
  if (type?.toUpperCase() === "GENERATION" || type?.toUpperCase() === "LLM") {
    const out = parse(output);
    if (typeof output === "string") {
      if (typeof out === "string") add("assistant", out, "output");
      else if (out !== null && typeof out !== "object") add("assistant", output, "output");
    } else if (out && typeof out === "object") {
      const r = out as Record<string, unknown>;
      if (r.role === "assistant") add("assistant", stringContent(r.content ?? r.text), "output");
      // choices were already traversed by walk(output, ...); avoid duplicate
      // assistant occurrences for OpenAI-compatible generation responses.
    }
  }
  return result;
}
export function normalizeSearchText(text: string): string {
  return normalize(text);
}
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function chunkText(text: string): TextChunk[] {
  const chars = Array.from(text);
  if (!chars.length) return [];
  const chunks: TextChunk[] = [];
  let start = 0;
  let no = 0;
  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    while (end < chars.length) {
      const nextBytes = Buffer.byteLength(chars[end], "utf8");
      if (end > start && bytes + nextBytes > CHUNK_BYTES) break;
      bytes += nextBytes;
      end++;
    }
    const displayStart = chars.slice(0, start).join("").length;
    const displayEnd = displayStart + chars.slice(start, end).join("").length;
    chunks.push({
      text: chars.slice(start, end).join(""),
      chunkNo: no++,
      start: displayStart,
      end: displayEnd,
    });
    if (end === chars.length) break;
    start = end - OVERLAP;
  }
  return chunks;
}
