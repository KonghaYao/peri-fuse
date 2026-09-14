import { getTelemetryDB } from "../adapters";
import { findHighlightRanges } from "./highlight";
import { querySessionSearchRead } from "./read-pool";
import type { ContextMessage, ContextRequest, ContextResponse } from "./types";

const MAX_BYTES = 32 * 1024;
const MAX_MESSAGES = 5;
const MAX_BLOCKS = 5;
type Cursor = {
  d: "before" | "after" | "block" | "block-before";
  p: string;
  k: string;
  s: string;
  v: number;
  m: number;
  c: number;
};
const encode = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url");

function decode(
  raw: string | undefined,
  projectId: string,
  anchor: Record<string, unknown>,
): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      !["before", "after", "block", "block-before"].includes(String(cursor.d)) ||
      cursor.p !== projectId ||
      cursor.k !== String(anchor.source_kind) ||
      cursor.s !== String(anchor.source_id) ||
      cursor.v !== Number(anchor.source_version) ||
      !Number.isSafeInteger(cursor.m) ||
      !Number.isSafeInteger(cursor.c) ||
      cursor.m < 0 ||
      cursor.c < 0
    )
      throw new Error();
    return cursor as Cursor;
  } catch {
    throw new Error("CONTEXT_STALE");
  }
}

type Row = {
  occurrence_id: string;
  role: "user" | "assistant";
  field: string;
  message_order: number;
  chunk_no: number;
  display_text: string;
  display_start: number;
  display_end: number;
  trace_id: string | null;
  session_id: string | null;
};

export async function getSessionContext(
  projectId: string,
  input: ContextRequest,
  signal?: AbortSignal,
): Promise<ContextResponse> {
  const db = getTelemetryDB();
  const deadline = Date.now() + 500;
  const read = <T>(query: string, params: Record<string, unknown>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SEARCH_TIMEOUT");
    return querySessionSearchRead<T>(db, query, params, signal, remaining);
  };
  const anchors = await read<Record<string, unknown>>(
    `SELECT o.*, COALESCE(tr.session_id, trm.session_id) AS resolved_session_id,
      COALESCE(o.trace_id, CASE WHEN o.source_kind='trace' THEN o.source_id END) AS resolved_trace_id
      FROM search_occurrences o JOIN search_source_revisions sr ON sr.project_id=o.project_id AND sr.source_kind=o.source_kind AND sr.source_id=o.source_id AND sr.revision=o.source_version
      LEFT JOIN traces tr ON tr.project_id=o.project_id AND tr.id=CASE WHEN o.source_kind='trace' THEN o.source_id ELSE o.trace_id END AND tr.is_deleted=0
      LEFT JOIN trace_metrics trm ON trm.project_id=o.project_id AND trm.trace_id=o.trace_id
      WHERE o.project_id=@projectId AND o.occurrence_id=@id
      AND ((o.source_kind='trace' AND EXISTS (SELECT 1 FROM traces live WHERE live.project_id=o.project_id AND live.id=o.source_id AND live.is_deleted=0))
        OR (o.source_kind='observation' AND EXISTS (SELECT 1 FROM observations live WHERE live.project_id=o.project_id AND live.id=o.source_id AND live.is_deleted=0)
          AND EXISTS (SELECT 1 FROM traces parent WHERE parent.project_id=o.project_id AND parent.id=o.trace_id AND parent.is_deleted=0))) LIMIT 1`,
    { projectId, id: input.occurrenceId },
  );
  const anchor = anchors[0];
  if (!anchor) throw new Error("CONTEXT_UNAVAILABLE");
  if (Number(anchor.source_version) !== input.sourceVersion) throw new Error("CONTEXT_STALE");
  const beforeCursor = decode(input.beforeCursor, projectId, anchor),
    afterCursor = decode(input.afterCursor, projectId, anchor),
    blockCursor = decode(input.blockCursor, projectId, anchor),
    blockBeforeCursor = decode(input.blockBeforeCursor, projectId, anchor);
  if (
    (beforeCursor && beforeCursor.d !== "before") ||
    (afterCursor && afterCursor.d !== "after") ||
    (blockCursor && blockCursor.d !== "block") ||
    (blockBeforeCursor && blockBeforeCursor.d !== "block-before")
  )
    throw new Error("CONTEXT_STALE");
  const kind = String(anchor.source_kind),
    source = String(anchor.source_id),
    version = input.sourceVersion;
  const base = { p: projectId, k: kind, s: source, v: version };
  let orders: number[] = [],
    moreBefore = false,
    moreAfter = false;
  if (blockCursor || blockBeforeCursor) orders = [(blockCursor ?? blockBeforeCursor)!.m];
  else {
    const before = Math.min(Math.max(input.before ?? 2, 0), 2),
      after = Math.min(Math.max(input.after ?? 2, 0), 2);
    const boundary = beforeCursor?.m ?? afterCursor?.m;
    const condition =
      beforeCursor || afterCursor
        ? `message_order ${beforeCursor ? "<=" : ">="} @boundary`
        : "message_order BETWEEN @lo AND @hi";
    const orderRows = await read<{ message_order: number }>(
      `SELECT DISTINCT message_order FROM search_occurrences WHERE project_id=@projectId AND source_kind=@kind AND source_id=@source AND source_version=@version AND ${condition} ORDER BY message_order ${beforeCursor ? "DESC" : "ASC"} LIMIT @limit`,
      {
        projectId,
        kind,
        source,
        version,
        boundary,
        lo: Number(anchor.message_order) - before,
        hi: Number(anchor.message_order) + after,
        limit: MAX_MESSAGES + 1,
      },
    );
    orders = orderRows
      .slice(0, MAX_MESSAGES)
      .map((row) => Number(row.message_order))
      .sort((a, b) => a - b);
    if (beforeCursor) moreBefore = orderRows.length > orders.length;
    else moreAfter = orderRows.length > orders.length;
    if (!beforeCursor && !afterCursor) {
      const outside = await read<{ before: number; after: number }>(
        `SELECT MAX(message_order < @first) AS before, MAX(message_order > @last) AS after FROM search_occurrences WHERE project_id=@projectId AND source_kind=@kind AND source_id=@source AND source_version=@version`,
        { projectId, kind, source, version, first: orders[0], last: orders.at(-1) },
      );
      moreBefore = Boolean(outside[0]?.before);
      moreAfter = Boolean(outside[0]?.after);
    }
  }
  if (!orders.length) throw new Error("CONTEXT_UNAVAILABLE");
  const messages: ContextMessage[] = [];
  for (const order of orders) {
    const anchorChunk = order === Number(anchor.message_order) ? Number(anchor.chunk_no) : 0;
    const blockBefore = blockBeforeCursor !== undefined;
    const firstChunk =
      blockCursor || blockBeforeCursor
        ? (blockCursor ?? blockBeforeCursor)!.c
        : Math.max(0, anchorChunk - 2);
    const fetchedRows = await read<Row>(
      `SELECT o.occurrence_id,o.role,o.field,o.message_order,o.chunk_no,t.display_text,o.display_start,o.display_end,o.trace_id,o.session_id FROM search_occurrences o JOIN search_texts t ON t.text_id=o.text_id JOIN search_source_revisions sr ON sr.project_id=o.project_id AND sr.source_kind=o.source_kind AND sr.source_id=o.source_id AND sr.revision=o.source_version WHERE o.project_id=@projectId AND o.source_kind=@kind AND o.source_id=@source AND o.source_version=@version AND o.message_order=@order AND o.chunk_no ${blockBefore ? "<=" : ">="} @chunk ORDER BY o.chunk_no ${blockBefore ? "DESC" : "ASC"} LIMIT @limit`,
      { projectId, kind, source, version, order, chunk: firstChunk, limit: MAX_BLOCKS + 1 },
    );
    const rows = fetchedRows.slice(0, MAX_BLOCKS).sort((a, b) => a.chunk_no - b.chunk_no);
    if (!rows.length) continue;
    const hasMore = fetchedRows.length > MAX_BLOCKS;
    const nextChunkStart = async (row: Row): Promise<number> => {
      const next = await read<{ display_start: number }>(
        `SELECT o.display_start FROM search_occurrences o WHERE o.project_id=@projectId AND o.source_kind=@kind AND o.source_id=@source AND o.source_version=@version AND o.message_order=@order AND o.chunk_no>@chunk ORDER BY o.chunk_no LIMIT 1`,
        { projectId, kind, source, version, order, chunk: row.chunk_no },
      );
      return next[0]?.display_start ?? row.display_end;
    };
    const boundaries = await Promise.all(
      rows.map((row, index) =>
        rows[index + 1]?.display_start !== undefined
          ? Promise.resolve(rows[index + 1].display_start)
          : index === rows.length - 1 && (hasMore || blockBefore)
            ? nextChunkStart(row)
            : Promise.resolve(row.display_end),
      ),
    );
    const blocks = rows.map((row, index) => {
      const nextStart = boundaries[index];
      // display_start is the storage-owned absolute offset. Keep the range up to
      // the next chunk's start; this removes the overlap without guessing its size.
      const localStart = 0;
      const endOffset = nextStart;
      const localEnd = Math.max(
        localStart,
        Math.min(row.display_text.length, endOffset - row.display_start),
      );
      const text = row.display_text.slice(localStart, localEnd);
      return {
        text,
        chunkNo: row.chunk_no,
        truncated: false,
        highlight: [],
      };
    });
    if (input.query) {
      const combined = blocks.map((block) => block.text).join("");
      const ranges = findHighlightRanges(combined, input.query);
      let offset = 0;
      for (const block of blocks) {
        const blockStart = offset;
        const blockEnd = offset + block.text.length;
        block.highlight = ranges
          .map((range) => ({
            start: Math.max(range.start, blockStart) - blockStart,
            end: Math.min(range.end, blockEnd) - blockStart,
          }))
          .filter((range) => range.end > range.start);
        offset = blockEnd;
      }
    }
    messages.push({
      role: rows[0].role,
      field: rows[0].field,
      messageOrder: order,
      occurrenceId: `${kind}:${source}:${version}:${order}`,
      text: "",
      truncated: hasMore || firstChunk > 0,
      highlight: [],
      blocks,
      blockCursor:
        hasMore && !blockBefore
          ? encode({ ...base, d: "block", m: order, c: rows.at(-1)!.chunk_no + 1 })
          : null,
      blockBeforeCursor: (blockBefore ? hasMore : firstChunk > 0)
        ? encode({ ...base, d: "block-before", m: order, c: rows[0].chunk_no - 1 })
        : null,
    });
  }
  if (!messages.length) throw new Error("CONTEXT_UNAVAILABLE");
  const first = messages[0],
    last = messages.at(-1)!;
  const response: ContextResponse = {
    data: {
      sessionId: anchor.resolved_session_id ? String(anchor.resolved_session_id) : null,
      traceId: anchor.resolved_trace_id ? String(anchor.resolved_trace_id) : null,
      messages,
    },
    meta: {
      contextScope: "source",
      truncated: messages.some((m) => m.truncated),
      beforeCursor: moreBefore
        ? encode({ ...base, d: "before", m: first.messageOrder - 1, c: 0 })
        : null,
      afterCursor: moreAfter
        ? encode({ ...base, d: "after", m: last.messageOrder + 1, c: 0 })
        : null,
      sourceVersion: version,
    },
  };
  while (
    Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_BYTES &&
    response.data.messages.some((m) => m.blocks.length > 1)
  ) {
    const anchorOrder = Number(anchor.message_order);
    const candidate =
      response.data.messages.findLast(
        (m) => m.messageOrder !== anchorOrder && m.blocks.length > 1,
      ) ?? response.data.messages.find((m) => m.blocks.length > 1)!;
    const anchorIndex = candidate.blocks.findIndex(
      (block) => block.chunkNo === Number(anchor.chunk_no),
    );
    if (candidate.messageOrder === anchorOrder && anchorIndex === candidate.blocks.length - 1)
      candidate.blocks.shift();
    else candidate.blocks.pop();
    candidate.blockCursor = encode({
      ...base,
      d: "block",
      m: candidate.messageOrder,
      c: candidate.blocks.at(-1)!.chunkNo + 1,
    });
    candidate.blockBeforeCursor =
      candidate.blocks[0].chunkNo > 0
        ? encode({
            ...base,
            d: "block-before",
            m: candidate.messageOrder,
            c: candidate.blocks[0].chunkNo - 1,
          })
        : null;
    candidate.truncated = true;
    response.meta.truncated = true;
  }
  // Multibyte chunks can make five otherwise valid blocks exceed the wire cap.
  // Drop complete edge messages while retaining the anchor message and expose
  // the corresponding message cursor so the omitted context remains reachable.
  while (
    Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_BYTES &&
    response.data.messages.length > 1
  ) {
    const anchorOrder = Number(anchor.message_order);
    const removeLast = response.data.messages.at(-1)!.messageOrder !== anchorOrder;
    const removed = removeLast ? response.data.messages.pop()! : response.data.messages.shift()!;
    response.meta.truncated = true;
    if (removeLast)
      response.meta.afterCursor = encode({
        ...base,
        d: "after",
        m: removed.messageOrder,
        c: 0,
      });
    else
      response.meta.beforeCursor = encode({
        ...base,
        d: "before",
        m: removed.messageOrder,
        c: 0,
      });
  }
  return response;
}
