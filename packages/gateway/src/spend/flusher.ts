/**
 * Durable spend recording. The historical flusher API is retained for embedders,
 * but acceptance now commits Turso asynchronously instead of retaining events.
 */

import { sql } from "drizzle-orm";
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
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly options: SpendOptions = {}) {}

  /** Compatibility lifecycle: durable writes need no background timers. */
  start(): void {
    // Intentionally idempotent; there is no retained queue to schedule.
  }

  stop(): void {
    // Every accepted event has already committed.
  }

  /** Fail admission before contacting an upstream if SQLite cannot accept a writer. */
  async assertWritable(): Promise<void> {
    try {
      await getDb().transaction(
        async (tx) => {
          await tx.run(sql`UPDATE _perifuse_migrations SET name=name WHERE 0`);
        },
        { behavior: "immediate" },
      );
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
  async enqueue(event: SpendEvent): Promise<void> {
    const write = this.commit(event);
    this.inflight.add(write);
    try {
      await write;
    } finally {
      this.inflight.delete(write);
    }
  }

  private async commit(event: SpendEvent): Promise<void> {
    try {
      await recordSpend(getDb(), event, {
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
    return { accepted: this.accepted, failures: this.failures, pending: this.inflight.size };
  }

  /** Shutdown waits for all in-flight writes to settle. */
  async flush(): Promise<void> {
    await this.flushAll();
  }
  async flushDaily(): Promise<void> {
    await this.flushAll();
  }
  async flushAll(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}

export const spendFlusher = new SpendFlusher();
