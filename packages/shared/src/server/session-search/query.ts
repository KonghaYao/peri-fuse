import { getTelemetryDB } from "../adapters";
import { contentHash, normalizeSearchText } from "./extraction";
import { makeSnippet } from "./highlight";
import { querySessionSearchRead, stopSessionSearchReadPool } from "./read-pool";
import type { SessionSearchHit, SessionSearchRequest, SessionSearchResponse } from "./types";

const CANDIDATE_CAP = 1000;
const RESPONSE_BYTES = 64 * 1024;
const RANGE = [3600, 21600, 86400, 604800] as const;
type ResolvedRange = { from: string; to: string };
const iso = (value: Date) => value.toISOString();
export const INVALID_TIME_RANGE = "INVALID_TIME_RANGE";
function resolveRange(input: SessionSearchRequest["timeRange"]): ResolvedRange {
  const to = new Date();
  if (!input || input.kind === "relative") {
    const seconds = (input?.kind === "relative" ? input.seconds : undefined) ?? 3600;
    if (!RANGE.includes(seconds as (typeof RANGE)[number])) throw new Error(INVALID_TIME_RANGE);
    return { from: iso(new Date(to.getTime() - seconds * 1000)), to: iso(to) };
  }
  const from = new Date(input.fromTimestamp);
  const end = new Date(input.toTimestamp);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(end.getTime()) || from >= end)
    throw new Error(INVALID_TIME_RANGE);
  return { from: iso(from), to: iso(end) };
}

/** Stop the dedicated search reader for an adapter during shutdown. */
export { stopSessionSearchReadPool };
export async function searchSessions(
  projectId: string,
  input: SessionSearchRequest,
  signal?: AbortSignal,
): Promise<SessionSearchResponse> {
  if (signal?.aborted) {
    const error = new Error("Session search aborted");
    error.name = "AbortError";
    throw error;
  }
  const query = input.query.trim();
  const queryLength = Array.from(query).length;
  if (queryLength < 3) throw new Error("QUERY_TOO_SHORT");
  if (queryLength > 128) throw new Error("QUERY_TOO_LONG");
  const resolved = resolveRange(input.timeRange);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);
  const normalizedLiteral = normalizeSearchText(query);
  if (Array.from(normalizedLiteral).length < 3) throw new Error("QUERY_TOO_SHORT");
  const normalized = normalizedLiteral.replaceAll('"', '""');
  const deadline = Date.now() + 500;
  const budget = new AbortController();
  const abort = () => budget.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => budget.abort(), 500);
  timer.unref?.();
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  };
  const shortWindow = Date.parse(resolved.to) - Date.parse(resolved.from) <= 6 * 60 * 60 * 1000;
  const scope = contentHash(projectId).slice(0, 32);
  try {
    const candidateCte = shortWindow
      ? `WITH time_candidates AS MATERIALIZED (
      SELECT * FROM search_occurrences INDEXED BY idx_search_occ_window
      WHERE project_id=@projectId AND event_time >= @from AND event_time < @to
    )`
      : `WITH fts_candidates AS MATERIALIZED (
      SELECT rowid FROM search_fts
      WHERE normalized_text MATCH @match AND project_scope MATCH @scope
    )`;
    const candidateFrom = shortWindow
      ? `FROM time_candidates o
    JOIN search_texts t ON t.text_id=o.text_id AND t.project_id=@projectId`
      : `FROM fts_candidates f
    CROSS JOIN search_texts t ON t.text_id=f.rowid AND t.project_id=@projectId
    CROSS JOIN search_occurrences o INDEXED BY idx_search_occ_text
      ON o.text_id=t.text_id AND o.project_id=@projectId
      AND o.event_time >= @from AND o.event_time < @to`;
    const rows = await querySessionSearchRead<Record<string, unknown>>(
      getTelemetryDB(),
      `
    ${candidateCte}
    SELECT o.occurrence_id, o.source_version, o.source_kind, o.source_id, o.trace_id, o.role,
      o.field, o.message_order, o.chunk_no, o.event_time AS record_time, o.text_id,
      CASE WHEN o.source_kind='trace' THEN tr.session_id ELSE tr2.session_id END AS session_id,
      CASE WHEN o.source_kind='trace' THEN tr.user_id ELSE tr2.user_id END AS user_id,
      (SELECT pending FROM search_index_state WHERE project_id=@projectId) AS index_pending,
      (SELECT coverage FROM search_index_state WHERE project_id=@projectId) AS index_coverage
    ${candidateFrom}
    LEFT JOIN observations ob ON o.source_kind='observation' AND ob.project_id=o.project_id AND ob.id=o.source_id AND ob.is_deleted=0
    LEFT JOIN traces tr ON o.source_kind='trace' AND tr.project_id=o.project_id AND tr.id=o.source_id AND tr.is_deleted=0
    LEFT JOIN traces tr2 ON o.source_kind='observation' AND tr2.project_id=o.project_id AND tr2.id=o.trace_id AND tr2.is_deleted=0
    JOIN search_source_revisions sr ON sr.project_id=o.project_id AND sr.source_kind=o.source_kind AND sr.source_id=o.source_id AND sr.revision=o.source_version
    WHERE t.project_id=@projectId AND ${shortWindow ? "instr(t.normalized_text,@literal)>0" : "1=1"}
      AND ((o.source_kind='trace' AND tr.id IS NOT NULL) OR (o.source_kind='observation' AND ob.id IS NOT NULL AND tr2.id IS NOT NULL))
    ORDER BY o.event_time DESC, o.occurrence_id DESC LIMIT @cap`,
      {
        projectId,
        literal: normalizedLiteral,
        match: `"${normalized}"`,
        scope,
        from: resolved.from,
        to: resolved.to,
        cap: CANDIDATE_CAP + 1,
      },
      budget.signal,
      Math.max(1, deadline - Date.now()),
    );
    // Select the bounded set of sessions and message hits before loading text.
    // A repeated message in one session must not consume the text-id budget and
    // leave later sessions with empty snippets.
    const rowsBySession = new Map<string, Record<string, unknown>[]>();
    const seenMessages = new Set<string>();
    for (const row of rows) {
      const sessionId = String(row.session_id ?? "");
      if (!sessionId) continue;
      const messageKey = `${row.source_kind}:${row.source_id}:${row.field}:${row.message_order}`;
      if (seenMessages.has(messageKey)) continue;
      seenMessages.add(messageKey);
      const list = rowsBySession.get(sessionId) ?? [];
      if (list.length < 2) list.push(row);
      rowsBySession.set(sessionId, list);
    }
    const selectedRows = [...rowsBySession.values()].slice(0, limit).flat();
    const textIds = [
      ...new Set(selectedRows.map((row) => Number(row.text_id)).filter(Number.isInteger)),
    ].slice(0, 40);
    const textMap = new Map<number, string>();
    if (textIds.length) {
      const names = textIds.map((_, index) => `@text${index}`);
      const params: Record<string, unknown> = {};
      textIds.forEach((id, index) => {
        params[`text${index}`] = id;
      });
      const texts = await querySessionSearchRead<Record<string, unknown>>(
        getTelemetryDB(),
        `SELECT text_id,display_text FROM search_texts WHERE project_id=@projectId AND text_id IN (${names.join(",")})`,
        { ...params, projectId },
        budget.signal,
        Math.max(1, deadline - Date.now()),
      );
      for (const text of texts) textMap.set(Number(text.text_id), String(text.display_text ?? ""));
    }
    const grouped = new Map<string, { userId: string | null; hits: SessionSearchHit[] }>();
    for (const row of selectedRows) {
      const sessionId = String(row.session_id ?? "");
      if (!sessionId) continue;
      const s = makeSnippet(textMap.get(Number(row.text_id)) ?? "", query);
      const hit: SessionSearchHit = {
        occurrenceId: String(row.occurrence_id),
        sourceVersion: Number(row.source_version),
        sourceKind: String(row.source_kind),
        sourceId: String(row.source_id),
        traceId: row.trace_id ? String(row.trace_id) : null,
        userId: row.user_id ? String(row.user_id) : null,
        role: row.role as "user" | "assistant",
        field: String(row.field),
        messageOrder: Number(row.message_order),
        recordTime: String(row.record_time ?? ""),
        snippet: s.text,
        highlight: s.ranges,
        sourceAnchor: {
          traceId: row.trace_id ? String(row.trace_id) : null,
          sourceKind: String(row.source_kind),
          sourceId: String(row.source_id),
          field: String(row.field),
          messageOrder: Number(row.message_order),
          chunkNo: Number(row.chunk_no),
        },
      };
      const group = grouped.get(sessionId) ?? { userId: hit.userId ?? null, hits: [] };
      if (group.hits.length < 2) group.hits.push(hit);
      if (!group.userId && hit.userId) group.userId = hit.userId;
      grouped.set(sessionId, group);
    }
    let data = [...grouped]
      .slice(0, limit)
      .map(([sessionId, group]) => ({ sessionId, userId: group.userId, hits: group.hits }));
    const limited = rows.length > CANDIDATE_CAP || grouped.size > limit;
    const state = await querySessionSearchRead<Record<string, unknown>>(
      getTelemetryDB(),
      "SELECT pending,coverage,last_error FROM search_index_state WHERE project_id=@projectId OR project_id IN ('__global__','__backfill__') ORDER BY CASE WHEN project_id=@projectId THEN 0 ELSE 1 END",
      { projectId },
      budget.signal,
      Math.max(1, deadline - Date.now()),
    );
    const pending = Number(state[0]?.pending ?? 0);
    const coverage = state.length ? String(state[0]?.coverage ?? "unknown") : "new";
    const meta = {
      returnedSessions: data.length,
      limited,
      limitReason: limited ? ("candidate_cap" as const) : null,
      indexState: state.length
        ? state[0]?.last_error
          ? ("unavailable" as const)
          : pending > 0
            ? ("indexing" as const)
            : ("ready" as const)
        : ("unavailable" as const),
      coverage,
      resolvedTimeRange: { fromTimestamp: resolved.from, toTimestamp: resolved.to },
    };
    while (
      Buffer.byteLength(JSON.stringify({ data, meta }), "utf8") > RESPONSE_BYTES &&
      data.length
    ) {
      data = data.slice(0, -1);
      meta.returnedSessions = data.length;
      meta.limited = true;
      meta.limitReason = "candidate_cap";
    }
    return { data, meta };
  } finally {
    cleanup();
  }
}
