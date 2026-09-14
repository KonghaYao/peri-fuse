import { describe, expect, it } from "vitest";
import { chunkText, extractMessages } from "./extraction";

describe("session search extraction boundaries", () => {
  it("preserves scalar generation output and visible content blocks", () => {
    expect(extractMessages(undefined, "123", "GENERATION")).toEqual([
      { role: "assistant", text: "123", field: "output", order: 0 },
    ]);
    expect(extractMessages(undefined, JSON.stringify("hello"), "GENERATION")[0]?.text).toBe(
      "hello",
    );
    expect(extractMessages(undefined, "null", "GENERATION")).toHaveLength(0);
    const choices = { choices: [{ message: { role: "assistant", content: "once" } }] };
    expect(
      extractMessages(undefined, choices, "GENERATION").filter((m) => m.text === "once"),
    ).toHaveLength(1);
    expect(
      extractMessages(
        { messages: [{ role: "user", content: [{ type: "input_text", text: "visible" }] }] },
        undefined,
      ),
    ).toHaveLength(1);
    expect(
      extractMessages(undefined, { messages: [{ role: "tool", content: "secret" }] }),
    ).toHaveLength(0);
  });

  it("uses UTF-16 offsets while cutting chunks on UTF-8 byte budget", () => {
    const chunks = chunkText("🙂".repeat(1100));
    expect(chunks[0].text).toHaveLength(2048);
    expect(chunks[1].start).toBe(chunks[0].end - 127 * 2);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.text) <= 4096)).toBe(true);
  });
});
