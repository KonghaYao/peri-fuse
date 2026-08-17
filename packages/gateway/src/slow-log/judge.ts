/**
 * Slow request detection — pure functions, unit-testable.
 */
export interface SlowCandidate {
  latencyMs: number;
  ttftMs?: number;
  stream?: boolean;
}

/**
 * A call is slow when its perceived latency exceeds the threshold (strictly
 * greater than). Non-streaming calls are judged by total latency. Streaming
 * calls are judged by time-to-first-token only — total duration of a stream
 * grows with output length and is not a slowness signal.
 */
export function isSlow(candidate: SlowCandidate, thresholdMs: number): boolean {
  if (candidate.stream && candidate.ttftMs !== undefined) {
    return candidate.ttftMs > thresholdMs;
  }
  return candidate.latencyMs > thresholdMs;
}
