/** Session search API types (`/api/public/session-search`). */

export type SessionSearchTimeRange =
  | { kind: "relative"; seconds: 3600 | 21600 | 86400 | 604800 }
  | { kind: "absolute"; fromTimestamp: string; toTimestamp: string };

export type SessionSearchHit = {
  occurrenceId: string;
  sourceVersion: number;
  sessionId: string;
  sourceKind: string;
  sourceId: string;
  traceId: string | null;
  role: "user" | "assistant";
  field: string;
  messageOrder: number;
  recordTime: string;
  snippet: string;
  highlight: Array<{ start: number; end: number }>;
  sourceAnchor: {
    traceId: string | null;
    sourceKind: string;
    sourceId: string;
    field: string;
    messageOrder: number;
    chunkNo: number;
  };
};

export type SessionSearchGroup = {
  sessionId: string;
  userId?: string | null;
  hits: SessionSearchHit[];
};

export type SessionSearchResponse = {
  data: SessionSearchGroup[];
  meta: {
    returnedSessions: number;
    limited: boolean;
    limitReason?: string | null;
    indexState?: string;
    coverage?: number | string | null;
    resolvedTimeRange?: { fromTimestamp: string; toTimestamp: string };
  };
};

export type SessionContextMessage = {
  role: "user" | "assistant";
  text: string;
  field: string;
  messageOrder: number;
  occurrenceId: string;
  truncated: boolean;
  highlight: Array<{ start: number; end: number }>;
  blocks: Array<{
    text: string;
    chunkNo: number;
    truncated: boolean;
    highlight: Array<{ start: number; end: number }>;
  }>;
  blockCursor: string | null;
  blockBeforeCursor: string | null;
};

export type SessionSearchContext = {
  data: {
    sessionId: string;
    occurrenceId: string;
    messages: SessionContextMessage[];
  };
  meta: {
    contextScope: "source";
    truncated: boolean;
    beforeCursor: string | null;
    afterCursor: string | null;
    sourceVersion: number;
  };
};
