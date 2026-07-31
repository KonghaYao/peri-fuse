/**
 * SpendFlusher — batch write queue for spend logs (inspired by LiteLLM DBSpendUpdateWriter).
 * Queues spend events in memory and flushes to SQLite periodically.
 */
import { getDb } from "../db.js";
import { gatewayEnv } from "../env.js";

export interface SpendEvent {
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
}

interface DailySpendIncrement {
  apiKey: string;
  date: string;
  model: string;
  modelGroup: string | null;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  spend: number;
  success: boolean;
}

class SpendFlusher {
  private spendLogQueue: SpendEvent[] = [];
  private dailySpendQueue: DailySpendIncrement[] = [];
  private keySpendQueue = new Map<string, number>(); // publicKey -> spend increment
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dailyFlushTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error("[spend-flusher] flush error:", err));
    }, gatewayEnv.flushIntervalMs);

    this.dailyFlushTimer = setInterval(() => {
      this.flushDaily().catch((err) => console.error("[spend-flusher] daily flush error:", err));
    }, gatewayEnv.dailyFlushIntervalMs);

    // Allow process to exit
    if (this.flushTimer.unref) this.flushTimer.unref();
    if (this.dailyFlushTimer.unref) this.dailyFlushTimer.unref();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.dailyFlushTimer) clearInterval(this.dailyFlushTimer);
  }

  /**
   * Enqueue a spend event for batch writing.
   */
  enqueue(event: SpendEvent): void {
    this.spendLogQueue.push(event);

    // Also queue daily aggregation
    const date = event.startTime.toISOString().slice(0, 10);
    this.dailySpendQueue.push({
      apiKey: event.apiKey,
      date,
      model: event.model || "",
      modelGroup: event.modelGroup || null,
      provider: event.provider || "",
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      spend: event.spend,
      success: event.status === "success",
    });

    // Queue key spend increment
    if (event.apiKey) {
      const current = this.keySpendQueue.get(event.apiKey) ?? 0;
      this.keySpendQueue.set(event.apiKey, current + event.spend);
    }
  }

  /**
   * Flush spend logs to database.
   */
  async flush(): Promise<void> {
    if (this.spendLogQueue.length === 0) return;

    const batch = this.spendLogQueue.splice(0, this.spendLogQueue.length);
    const db = getDb();

    try {
      await db.spendLog.createMany({
        data: batch.map((e) => ({
          callType: e.callType,
          apiKey: e.apiKey,
          spend: e.spend,
          totalTokens: e.totalTokens,
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
          startTime: e.startTime,
          endTime: e.endTime,
          completionStartTime: e.completionStartTime,
          requestDurationMs: e.requestDurationMs,
          model: e.model,
          modelId: e.modelId,
          modelGroup: e.modelGroup,
          provider: e.provider,
          apiBase: e.apiBase,
          protocol: e.protocol,
          user: e.user,
          metadata: e.metadata ?? "{}",
          requestTags: e.requestTags ?? "[]",
          sessionId: e.sessionId,
          status: e.status,
          messages: e.messages,
          response: e.response,
          errorMessage: e.errorMessage,
          traceId: e.traceId,
        })),
      });
    } catch (err) {
      console.error(`[spend-flusher] Failed to write ${batch.length} spend logs:`, err);
      // Re-queue failed items (at the front)
      this.spendLogQueue.unshift(...batch);
    }

    // Flush key spend increments
    await this.flushKeySpend();
  }

  /**
   * Flush daily spend aggregations.
   */
  async flushDaily(): Promise<void> {
    if (this.dailySpendQueue.length === 0) return;

    const batch = this.dailySpendQueue.splice(0, this.dailySpendQueue.length);
    const db = getDb();

    // Aggregate by unique key
    const aggregated = new Map<string, DailySpendIncrement>();
    for (const item of batch) {
      const key = `${item.apiKey}|${item.date}|${item.model}|${item.provider}`;
      const existing = aggregated.get(key);
      if (existing) {
        existing.promptTokens += item.promptTokens;
        existing.completionTokens += item.completionTokens;
        existing.spend += item.spend;
        if (item.success) {
          // count success
        }
      } else {
        aggregated.set(key, { ...item });
      }
    }

    for (const item of aggregated.values()) {
      try {
        await db.dailySpend.upsert({
          where: {
            apiKey_date_model_provider: {
              apiKey: item.apiKey,
              date: item.date,
              model: item.model,
              provider: item.provider,
            },
          },
          update: {
            promptTokens: { increment: item.promptTokens },
            completionTokens: { increment: item.completionTokens },
            spend: { increment: item.spend },
            apiRequests: { increment: 1 },
            successfulRequests: item.success ? { increment: 1 } : undefined,
            failedRequests: item.success ? undefined : { increment: 1 },
            updatedAt: new Date(),
          },
          create: {
            apiKey: item.apiKey,
            date: item.date,
            model: item.model,
            modelGroup: item.modelGroup,
            provider: item.provider,
            promptTokens: item.promptTokens,
            completionTokens: item.completionTokens,
            spend: item.spend,
            apiRequests: 1,
            successfulRequests: item.success ? 1 : 0,
            failedRequests: item.success ? 0 : 1,
          },
        });
      } catch (err) {
        console.error("[spend-flusher] Daily upsert error:", err);
      }
    }
  }

  private async flushKeySpend(): Promise<void> {
    if (this.keySpendQueue.size === 0) return;

    const entries = [...this.keySpendQueue.entries()];
    this.keySpendQueue.clear();

    const db = getDb();
    for (const [publicKey, spend] of entries) {
      try {
        await db.apiKey.updateMany({
          where: { publicKey },
          data: {
            spend: { increment: spend },
            lastActive: new Date(),
          },
        });
      } catch (err) {
        console.error("[spend-flusher] Key spend update error:", err);
      }
    }
  }

  /**
   * Flush all remaining data (called on shutdown).
   */
  async flushAll(): Promise<void> {
    await this.flush();
    await this.flushDaily();
  }
}

export const spendFlusher = new SpendFlusher();
