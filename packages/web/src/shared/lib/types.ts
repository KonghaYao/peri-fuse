/**
 * Response types for the lite-server public API (`/api/public/*`).
 *
 * These mirror the shapes produced by the lite-server's shaping layer, which
 * in turn ports the Langfuse public API contracts. Field optionality is kept
 * pragmatic — only fields the UI actually renders are modelled precisely.
 */

export type PaginationMeta = {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
};

export type Paged<T> = {
  data: T[];
  meta: PaginationMeta;
};

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

export type Trace = {
  id: string;
  timestamp: string;
  name: string | null;
  userId: string | null;
  sessionId: string | null;
  release: string | null;
  version: string | null;
  environment?: string | null;
  tags: string[];
  public?: boolean;
  bookmarked?: boolean;
  metadata?: unknown;
  input?: unknown;
  output?: unknown;
  externalId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TraceWithDetails = Trace & {
  latency: number; // seconds; -1 when metrics were not requested/available
  totalCost: number; // -1 when metrics were not requested/available
  observations: Observation[];
  observationCount: number; // -1 when metrics were not requested
  scores: Score[];
  htmlPath?: string;
};

export type TraceListParams = {
  page?: number;
  limit?: number;
  userId?: string;
  name?: string;
  sessionId?: string;
  environment?: string;
  version?: string;
  release?: string;
  fromTimestamp?: string; // ISO date-time
  toTimestamp?: string; // ISO date-time
  orderBy?: string; // e.g. "timestamp.desc"
};

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export type ObservationType = "SPAN" | "GENERATION" | "EVENT" | "AGENT" | "TOOL";

export type Observation = {
  id: string;
  traceId: string | null;
  parentObservationId: string | null;
  type: ObservationType | string;
  name: string | null;
  startTime: string;
  endTime: string | null;
  level: string | null;
  statusMessage: string | null;
  version: string | null;
  environment?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  model: string | null;
  modelId?: string | null;
  modelParameters?: unknown;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usage?: { input: number; output: number; total: number; unit: string };
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  calculatedInputCost?: number | null;
  calculatedOutputCost?: number | null;
  calculatedTotalCost?: number | null;
  completionStartTime?: string | null;
  promptId?: string | null;
  promptName?: string | null;
  promptVersion?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ObservationListParams = {
  page?: number;
  limit?: number;
  traceId?: string;
  userId?: string;
  name?: string;
  type?: string;
  level?: string;
  environment?: string;
  parentObservationId?: string;
  fromStartTime?: string;
  toStartTime?: string;
  version?: string;
};

export type CursorPage<T> = {
  data: T[];
  meta: { cursor: string | null };
};

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export type Score = {
  id: string;
  traceId: string | null;
  observationId: string | null;
  name: string;
  value: number | null;
  stringValue: string | null;
  source: string;
  dataType: string;
  comment: string | null;
  authorUserId?: string | null;
  configId?: string | null;
  environment?: string | null;
  queueId?: string | null;
  timestamp: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ScoreListParams = {
  page?: number;
  limit?: number;
  traceId?: string;
  observationId?: string;
  userId?: string;
  name?: string;
  source?: string;
  dataType?: string;
  configId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export type DashboardSummary = {
  totalTraces: number;
  totalObservations: number;
  totalGenerations: number;
  totalScores: number;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCachedTokens: number;
  cacheHitRate: number; // 0-1 fraction
  totalUsers: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  errorCount: number;
  errorRate: number; // 0-1 fraction
};

export type DashboardDaily = {
  date: string;
  traces: number;
  observations: number;
  tokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errors: number;
  cacheHitRate: number; // 0-1 fraction
  avgScore: number | null;
};

export type DashboardModelBucket = {
  model: string;
  observations: number;
  tokens: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export type DashboardLevelBucket = {
  level: string;
  count: number;
};

export type DashboardUserBucket = {
  userId: string;
  traces: number;
  tokens: number;
};

export type DashboardRecentError = {
  id: string;
  name: string | null;
  type: string | null;
  startTime: string | null;
  statusMessage: string | null;
  traceId: string | null;
  model: string | null;
};

export type Dashboard = {
  summary: DashboardSummary;
  daily: DashboardDaily[];
  byModel: DashboardModelBucket[];
  levels: DashboardLevelBucket[];
  topUsers: DashboardUserBucket[];
  recentErrors: DashboardRecentError[];
};

export type DashboardQueryParams = {
  from?: string; // ISO instant; omit for unbounded
  to?: string; // ISO instant; omit for unbounded
};

// ---------------------------------------------------------------------------
// Error investigation (GET /api/public/errors)
// ---------------------------------------------------------------------------

export type ErrorQueryParams = {
  from?: string;
  to?: string;
  search?: string;
  type?: string;
  model?: string;
  environment?: string;
};

export type ErrorEvent = {
  id: string;
  traceId: string | null;
  parentObservationId: string | null;
  name: string | null;
  type: string;
  startTime: string;
  endTime: string | null;
  statusMessage: string | null;
  model: string | null;
  environment: string | null;
  traceName: string | null;
  sessionId: string | null;
  userId: string | null;
};

export type ErrorAnalysis = {
  summary: {
    totalErrors: number;
    affectedTraces: number;
    uniqueSignatures: number;
    firstSeen: string | null;
    lastSeen: string | null;
  };
  groups: Array<{
    signature: string;
    count: number;
    traceCount: number;
    lastSeen: string;
  }>;
  models: Array<{ model: string; count: number }>;
  daily: Array<{ date: string; count: number }>;
  data: ErrorEvent[];
  meta: { cursor: string | null };
};

// ---------------------------------------------------------------------------
// Trace metrics (GET /api/public/traces/metrics)
// ---------------------------------------------------------------------------

export type TraceMetrics = {
  id: string;
  latency: number | null; // seconds
  observationCount: number;
  level: string; // ERROR | WARNING | DEBUG | DEFAULT
  errorCount: number;
  warningCount: number;
  debugCount: number;
  defaultCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number; // 0-1 fraction
  calculatedInputCost: number | null;
  calculatedOutputCost: number | null;
  calculatedTotalCost: number | null;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
};

// ---------------------------------------------------------------------------
// Sessions (GET /api/public/sessions, /api/public/sessions/:sessionId)
// ---------------------------------------------------------------------------

export type SessionRow = {
  id: string;
  createdAt: string;
  countTraces: number;
  sessionDuration: number | null; // seconds
  userIds: string[];
  traceTags: string[];
  environment: string;
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
};

export type SessionListParams = {
  page?: number;
  limit?: number;
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  orderBy?: string; // e.g. "createdAt.desc"
};

export type SessionScore = {
  id: string;
  observationId: string | null;
  name: string;
  value: number | null;
  stringValue: string | null;
  dataType: string;
  comment: string | null;
  source: string;
};

export type SessionTrace = {
  id: string;
  name: string | null;
  timestamp: string;
  userId: string | null;
  input: unknown;
  output: unknown;
  latency: number | null; // seconds
  totalCost: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number; // 0-1 fraction
  scores: SessionScore[];
  observations: Observation[];
};

export type SessionDetail = {
  id: string;
  createdAt: string;
  users: string[];
  countTraces: number;
  totalCost: number;
  totalTokens: number;
  usersTruncated?: boolean;
  meta?: PaginationMeta;
  sessionDuration: number; // seconds
  environment: string;
  traces: SessionTrace[];
};

// ---------------------------------------------------------------------------
// Users (GET /api/public/users)
// ---------------------------------------------------------------------------

export type UserRow = {
  id: string;
  firstSeen: string;
  lastSeen: string;
  countTraces: number;
  countObservations: number;
  environment: string;
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UserListParams = {
  page?: number;
  limit?: number;
  userId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  orderBy?: string; // e.g. "lastSeen.desc"
};

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

// ---------------------------------------------------------------------------
// Management API types
// ---------------------------------------------------------------------------

export type Project = {
  id: string;
  name: string;
  orgName: string;
  keyCount: number;
  createdAt: string;
};

export type ProjectKey = {
  id: string;
  publicKey: string;
  displaySecretKey: string;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type CreatedKey = {
  id: string;
  publicKey: string;
  secretKey: string;
  displaySecretKey: string;
};
