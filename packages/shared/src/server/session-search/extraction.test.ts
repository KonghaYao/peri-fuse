import { describe, expect, it } from "vitest";
import { chunkText, extractMessages, type TextChunk } from "./extraction";

const CHUNK_BYTES = 4096;
const OVERLAP = 127;

/**
 * Verbatim copy of the pre-optimization `chunkText` (extraction.ts:91), kept only as the
 * equivalence oracle for the optimized implementation. Its per-chunk `slice(0, start).join("")`
 * prefix rebuild is exactly what the fuzz tests pin down; do not "fix" anything in here.
 */
function referenceChunkText(text: string): TextChunk[] {
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

/** Deterministic PRNG so any fuzz failure is reproducible from the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1-, 2- and 3-byte UTF-8 code points, surrogate pairs, ZWJ sequences and lone surrogates. */
const UNICODE_POOL = [
  ..."abZ019 .,\t\n;:".split(""),
  "\u0000",
  "\u007f",
  "\u0080",
  "\u07ff",
  "\u0800",
  "\uffff",
  "é",
  "ß",
  "Ω",
  "ﬁ",
  "①",
  "中",
  "文",
  "日",
  "한",
  "𝌆",
  "𝄞",
  "🙂",
  "🚀",
  "❤️",
  "👍🏻",
  "👨‍👩‍👧‍👦",
  "\u0301",
  "\u0327",
  "\u200d",
  "\ufe0f",
  "\ud800",
  "\ud83d",
  "\udfff",
];

function randomUnicode(rng: () => number, codePoints: number): string {
  const parts: string[] = [];
  while (parts.length < codePoints) {
    const unit = UNICODE_POOL[Math.floor(rng() * UNICODE_POOL.length)];
    const repeat = rng() < 0.25 ? 1 + Math.floor(rng() * 8) : 1;
    for (let i = 0; i < repeat && parts.length < codePoints; i++) parts.push(unit);
  }
  return parts.join("");
}

/** UTF-16 prefix table over code points, used for structural assertions on the chunk fields. */
function utf16Offsets(text: string): Uint32Array {
  const chars = Array.from(text);
  const offsets = new Uint32Array(chars.length + 1);
  for (let i = 0; i < chars.length; i++) offsets[i + 1] = offsets[i] + chars[i].length;
  return offsets;
}

/** Maps a UTF-16 offset back to the code point index that starts there (binary search). */
function codePointIndexOf(offsets: Uint32Array, offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function assertChunkInvariants(text: string, chunks: TextChunk[]): void {
  chunks.forEach((chunk, index) => {
    expect(chunk.chunkNo).toBe(index);
    expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    expect(chunk.end).toBeGreaterThan(chunk.start);
    expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(CHUNK_BYTES);
    if (index > 0) expect(chunk.start).toBeGreaterThan(chunks[index - 1].start);
  });
  if (chunks.length) expect(chunks[chunks.length - 1].end).toBe(text.length);
}

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

describe("chunkText equivalence with the pre-optimization implementation", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(referenceChunkText("")).toEqual([]);
  });

  it("matches the reference on CJK, emoji, combining characters and long single characters", () => {
    const cases = [
      "",
      "a",
      "é",
      "中",
      "🙂",
      "中文搜索测试",
      "e\u0301\u0327\u0301 combining marks",
      "한글 검색",
      "\u0000\u007f\u0080\u07ff\u0800\uffff",
      "\ud800\udfff lone surrogates",
      "𝌆𝄞𝌆", // 4-byte, non-emoji code points
      "👨‍👩‍👧‍👦👩🏽‍🚀❤️🇨🇳",
      "中".repeat(2000), // 6000 UTF-8 bytes, so several chunks
      "🙂".repeat(1100),
      "é".repeat(3000),
      "\u0301".repeat(5000),
      "a".repeat(CHUNK_BYTES - 1),
      "a".repeat(CHUNK_BYTES),
      "a".repeat(CHUNK_BYTES + 1),
      `${"a".repeat(CHUNK_BYTES - 4)}🙂`,
      `${"a".repeat(CHUNK_BYTES - 4)}𝌆`,
      `${"a".repeat(CHUNK_BYTES * 2 - 2)}中`,
    ];
    for (const text of cases) {
      const chunks = chunkText(text);
      expect(chunks).toEqual(referenceChunkText(text));
      assertChunkInvariants(text, chunks);
    }
    // Single chunk exactly on the budget: the whole text is emitted, no trailing empty chunk.
    expect(chunkText("a".repeat(CHUNK_BYTES))).toEqual([
      { text: "a".repeat(CHUNK_BYTES), chunkNo: 0, start: 0, end: CHUNK_BYTES },
    ]);
  });

  it("matches the reference when a multi-byte character straddles the byte budget", () => {
    const suffixes = ["", "a", "é", "中", "🙂", "𝌆", "\u0301", "👨‍👩‍👧‍👦"];
    const bases = [
      0,
      1,
      CHUNK_BYTES - 4,
      CHUNK_BYTES - 3,
      CHUNK_BYTES - 2,
      CHUNK_BYTES - 1,
      CHUNK_BYTES,
      CHUNK_BYTES + 1,
      CHUNK_BYTES * 2 - 2,
      CHUNK_BYTES * 2,
      CHUNK_BYTES * 2 + 3,
    ];
    for (const base of bases) {
      for (const suffix of suffixes) {
        const text = `${"a".repeat(base)}${suffix}`;
        const chunks = chunkText(text);
        expect(chunks).toEqual(referenceChunkText(text));
        assertChunkInvariants(text, chunks);
      }
    }
  });

  it("matches the reference on seeded random Unicode input", () => {
    const rng = mulberry32(0x5eed_c0de);
    const sizes = [
      0, 1, 2, 3, 7, 31, 126, 127, 128, 129, 255, 1024, 1023, 1024, 4095, 4096, 4097, 8192, 12288,
      20000, 40096, 65536,
    ];
    for (const size of sizes) {
      const text = randomUnicode(rng, size);
      const chunks = chunkText(text);
      expect(chunks).toEqual(referenceChunkText(text));
      assertChunkInvariants(text, chunks);
    }
    for (let round = 0; round < 150; round++) {
      const text = randomUnicode(rng, Math.floor(rng() * 4096));
      expect(chunkText(text)).toEqual(referenceChunkText(text));
    }
  });

  it("keeps the 127 code point overlap across mixed-width characters", () => {
    const text = "é中🙂a\u0301".repeat(2000);
    const offsets = utf16Offsets(text);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(text.length);
    assertChunkInvariants(text, chunks);
    for (let i = 1; i < chunks.length; i++) {
      const previousEnd = codePointIndexOf(offsets, chunks[i - 1].end);
      // 127 code points back, not 127 UTF-16 units.
      expect(chunks[i].start).toBe(offsets[previousEnd - OVERLAP]);
    }
    expect(chunks).toEqual(referenceChunkText(text));
  });
});
