export type SearchTimeRange =
  | { kind: "relative"; seconds?: 3600 | 21600 | 86400 | 604800 }
  | { kind: "absolute"; fromTimestamp: string; toTimestamp: string };

export type SessionSearchRequest = { query: string; timeRange?: SearchTimeRange; limit?: number };
export type HighlightRange = { start: number; end: number };
export type SessionSearchHit = {
  userId?: string | null;
  occurrenceId: string;
  sourceVersion: number;
  sourceKind: string;
  sourceId: string;
  traceId: string | null;
  role: "user" | "assistant";
  field: string;
  messageOrder: number;
  recordTime: string;
  snippet: string;
  highlight: HighlightRange[];
  sourceAnchor: {
    traceId: string | null;
    sourceKind: string;
    sourceId: string;
    field: string;
    messageOrder: number;
    chunkNo: number;
  };
};
export type SessionSearchResult = {
  sessionId: string;
  userId?: string | null;
  hits: SessionSearchHit[];
};
export type SessionSearchResponse = {
  data: SessionSearchResult[];
  meta: {
    returnedSessions: number;
    limited: boolean;
    limitReason: "candidate_cap" | "time_budget" | "queue_overloaded" | null;
    indexState: "ready" | "indexing" | "unavailable";
    coverage: string;
    resolvedTimeRange: { fromTimestamp: string; toTimestamp: string };
  };
};

export type ContextRequest = {
  occurrenceId: string;
  sourceVersion: number;
  query?: string;
  before?: number;
  after?: number;
  beforeCursor?: string;
  afterCursor?: string;
  blockCursor?: string;
  blockBeforeCursor?: string;
};
export type ContextMessage = {
  role: "user" | "assistant";
  text: string;
  field: string;
  messageOrder: number;
  occurrenceId: string;
  truncated: boolean;
  highlight: HighlightRange[];
  blocks: Array<{ text: string; chunkNo: number; truncated: boolean; highlight: HighlightRange[] }>;
  blockCursor: string | null;
  blockBeforeCursor: string | null;
};
export type ContextResponse = {
  data: { sessionId: string | null; traceId: string | null; messages: ContextMessage[] };
  meta: {
    contextScope: "source";
    truncated: boolean;
    beforeCursor: string | null;
    afterCursor: string | null;
    sourceVersion: number;
  };
};

export type SessionSearchErrorCode =
  | "QUERY_TOO_SHORT"
  | "SEARCH_BUSY"
  | "SEARCH_TIMEOUT"
  | "CONTEXT_STALE"
  | "CONTEXT_UNAVAILABLE";
