/**
 * Durable spend recording. The historical flusher API is retained for embedders,
 * but acceptance now commits SQLite synchronously instead of retaining events.
 */
import { getDb } from "../db.js";
import { gatewayEnv } from "../env.js";
import { slowLogWriter } from "../slow-log/writer.js";
import { recordSpend } from "./record.js";

export interface SpendEvent {
  projectId: string;
  callType: string;
  apiKey: string;
  spend: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  startTime: Date;
  endTime: Date;
  completionStartTime?: Date;
  requestDurationMs?: number;
  model: string;
  modelId?: string;
  modelGroup?: string;
  provider?: string;
  apiBase?: string;
  protocol?: string;
  user?: string;
  metadata?: string;
  requestTags?: string;
  sessionId?: string;
  status?: string;
  messages?: string;
  response?: string;
  errorMessage?: string;
  traceId?: string;
  stream?: boolean;
}

export class SpendWriteError extends Error {
  readonly statusCode = 503;

  constructor(cause: unknown) {
    super("Spend accounting is temporarily unavailable", { cause });
    this.name = "SpendWriteError";
  }
}

interface SpendOptions {
  logRequests?: boolean;
  logMaxBodySize?: number;
}

export class SpendFlusher {
  private accepted = 0;
  private failures = 0;

  constructor(private readonly options: SpendOptions = {}) {}

  /** Compatibility lifecycle: durable writes need no background timers. */
  start(): void {
    // Intentionally idempotent; there is no retained queue to schedule.
  }

  stop(): void {
    // Every accepted event has already committed.
  }

  /** Fail admission before contacting an upstream if SQLite cannot accept a writer. */
  assertWritable(): void {
    try {
      getDb().transaction(() => undefined, { behavior: "immediate" });
    } catch (cause) {
      this.failures++;
      console.error("[spend-flusher] Accounting admission failed:", cause);
      throw new SpendWriteError(cause);
    }
  }

  /**
   * Return only after the event and its accounting increments commit together.
   * Rejected events are never queued or partially counted; the caller must surface
   * the error, including when an upstream response has already started streaming.
   */
  enqueue(event: SpendEvent): void {
    try {
      recordSpend(getDb(), event, {
        logRequests: this.options.logRequests ?? gatewayEnv.logRequests,
        logMaxBodySize: this.options.logMaxBodySize ?? gatewayEnv.logMaxBodySize,
      });
      this.accepted++;
    } catch (cause) {
      this.failures++;
      console.error("[spend-flusher] Accounting commit failed:", cause);
      throw new SpendWriteError(cause);
    }

    if (gatewayEnv.slowLogEnabled) {
      slowLogWriter.writeIfSlow({
        projectId: event.projectId,
        callType: event.callType,
        apiKey: event.apiKey,
        model: event.model,
        modelGroup: event.modelGroup,
        provider: event.provider,
        endTime: event.endTime,
        latencyMs: event.requestDurationMs ?? event.endTime.getTime() - event.startTime.getTime(),
        ttftMs: event.completionStartTime
          ? event.completionStartTime.getTime() - event.startTime.getTime()
          : undefined,
        stream: event.stream,
        status: event.status,
        errorMessage: event.errorMessage,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        spend: event.spend,
        traceId: event.traceId,
      });
    }
  }

  /** Counters are process-local; no event payloads are retained for diagnostics. */
  stats(): { accepted: number; failures: number; pending: number } {
    return { accepted: this.accepted, failures: this.failures, pending: 0 };
  }

  /** Compatibility methods: all accepted writes are already durable. */
  async flush(): Promise<void> {}
  async flushDaily(): Promise<void> {}
  async flushAll(): Promise<void> {}
}

export const spendFlusher = new SpendFlusher();
