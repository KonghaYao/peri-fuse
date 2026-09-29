import { parseMaybeString } from "@/shared/components/chat-utils";

function outputText(value: unknown, budget: number, depth = 0): string {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") {
    const parsed = parseMaybeString(value);
    return parsed !== null && typeof parsed === "object"
      ? outputText(parsed, budget, depth + 1)
      : value.replace(/\s+/g, " ").trim().slice(0, budget);
  }
  if (Array.isArray(value)) {
    let text = "";
    for (const part of value.slice(0, 64)) {
      const next = outputText(part, budget - text.length, depth + 1);
      if (next) text += `${text ? " " : ""}${next}`;
      if (text.length >= budget) break;
    }
    return text;
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  // Preview only assistant prose: inputs, tool arguments/results, and reasoning
  // are distinct payloads, even when nested beside the answer in an output.
  if (typeof record.role === "string" && record.role.toLowerCase() !== "assistant") return "";
  if (
    typeof record.type === "string" &&
    /thinking|reasoning|tool|function|image|audio|input/.test(record.type)
  ) {
    return "";
  }
  for (const key of [
    "output_text",
    "text",
    "content",
    "message",
    "messages",
    "choices",
    "output",
    "response",
  ]) {
    const candidate = record[key];
    if (key === "text" && candidate && typeof candidate === "object" && "value" in candidate) {
      const text = outputText(candidate.value, budget, depth + 1);
      if (text) return text;
    }
    const text = outputText(candidate, budget, depth + 1);
    if (text) return text;
  }
  return "";
}

/** Leading assistant text across plain, chat-completion, Responses and Anthropic outputs. */
export function getGenerationPreview(output: unknown, maxChars = 60): string | null {
  // Read a bounded prefix; two UTF-16 units per code point also cover emoji.
  const chars = Array.from(
    outputText(output, (maxChars + 1) * 2)
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!chars.length) return null;
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : chars.join("");
}
