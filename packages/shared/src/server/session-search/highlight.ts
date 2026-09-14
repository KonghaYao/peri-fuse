import type { HighlightRange } from "./types";

type Normalized = { text: string; starts: number[]; ends: number[] };
export function normalizeWithOffsets(input: string): Normalized {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace = false;
  const segments =
    typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input)].map(
          (x) => x.segment,
        )
      : Array.from(input);
  let rawOffset = 0;
  for (const char of segments) {
    const start = rawOffset;
    rawOffset += char.length;
    if (/^\s+$/u.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && text) {
      text += " ";
      starts.push(start);
      ends.push(start);
      pendingSpace = false;
    }
    const normalized = Array.from(char.normalize("NFKC").toLocaleLowerCase());
    text += normalized.join("");
    starts.push(...normalized.map(() => start));
    ends.push(...normalized.map(() => rawOffset));
  }
  return { text, starts, ends };
}

export function findHighlightRanges(text: string, query: string): HighlightRange[] {
  const source = normalizeWithOffsets(text);
  const needle = normalizeWithOffsets(query).text;
  if (!needle) return [];
  const sourceChars = Array.from(source.text);
  const needleChars = Array.from(needle);
  const ranges: HighlightRange[] = [];
  for (let at = sourceChars.join("").indexOf(needle); at >= 0; ) {
    const codepointAt = Array.from(sourceChars.join("").slice(0, at)).length;
    const start = source.starts[codepointAt] ?? 0;
    const end = source.ends[codepointAt + needleChars.length - 1] ?? start;
    ranges.push({ start, end });
    const next = at + Math.max(1, needle.length);
    if (next >= source.text.length) break;
    at = source.text.indexOf(needle, next);
  }
  return ranges;
}

/** Locate normalized query text while returning offsets into the original UTF-16 string. */
export function makeSnippet(
  text: string,
  query: string,
): { text: string; ranges: HighlightRange[] } {
  const source = normalizeWithOffsets(text);
  const needle = normalizeWithOffsets(query).text;
  const at = source.text.indexOf(needle);
  if (at < 0 || !needle) return { text: text.slice(0, 240), ranges: [] };
  const rawStart = source.starts[at] ?? 0;
  const startIndex = Array.from(source.text.slice(0, at)).length;
  const endIndex = startIndex + Array.from(needle).length - 1;
  const rawEnd = source.ends[endIndex] ?? rawStart;
  const start = Math.max(0, rawStart - 120);
  const end = Math.min(text.length, rawEnd + 120);
  return {
    text: text.slice(start, end),
    ranges: [{ start: rawStart - start, end: rawEnd - start }],
  };
}
