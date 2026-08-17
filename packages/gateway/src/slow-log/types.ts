/**
 * Slow request log types.
 * A slow event is written as one JSON line to slow-YYYY-MM-DD.log.
 */
export interface SlowLogEvent {
  projectId: string;
  callType: string;
  apiKey?: string;
  model: string;
  modelGroup?: string;
  provider?: string;
  endTime: Date;
  latencyMs: number;
  ttftMs?: number;
  stream?: boolean;
  status?: string;
  errorMessage?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  spend?: number;
  traceId?: string;
}
