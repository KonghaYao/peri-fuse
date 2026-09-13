import { and, eq, sql } from "drizzle-orm";
import { apiKey, dailySpend, spendLog } from "../db/schema.js";
import type { Db } from "../db.js";
import { generateId } from "../utils/id.js";
import type { SpendEvent } from "./flusher.js";

/** Bound encoded log payloads without allocating a buffer for the complete input. */
function boundedBody(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const bytes = Number.isSafeInteger(limit) && limit >= 0 ? limit : 10_240;
  const prefix = value.slice(0, bytes);
  if (Buffer.byteLength(prefix) <= bytes) return prefix;
  return new TextDecoder().decode(Buffer.from(prefix).subarray(0, bytes), { stream: true });
}

/**
 * A single-row transaction has a constant SQL parameter budget and no retry
 * queue. Logs, aggregates and budget counters either all commit or all roll back.
 */
export function recordSpend(
  db: Db,
  event: SpendEvent,
  options: { logRequests: boolean; logMaxBodySize: number },
): void {
  const startTime = event.startTime.toISOString();
  const endTime = event.endTime.toISOString();
  db.transaction((tx) => {
    if (options.logRequests) {
      tx.insert(spendLog)
        .values({
          id: generateId(),
          projectId: event.projectId,
          callType: event.callType,
          apiKey: event.apiKey,
          spend: event.spend,
          totalTokens: event.totalTokens,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          startTime,
          endTime,
          completionStartTime: event.completionStartTime?.toISOString(),
          requestDurationMs: event.requestDurationMs,
          model: event.model,
          modelId: event.modelId,
          modelGroup: event.modelGroup,
          provider: event.provider,
          apiBase: event.apiBase,
          protocol: event.protocol,
          user: event.user,
          metadata: event.metadata ?? "{}",
          requestTags: event.requestTags ?? "[]",
          sessionId: event.sessionId,
          status: event.status,
          messages: boundedBody(event.messages, options.logMaxBodySize),
          response: boundedBody(event.response, options.logMaxBodySize),
          errorMessage: boundedBody(event.errorMessage, options.logMaxBodySize),
          traceId: event.traceId,
        })
        .run();
    }

    const success = event.status === "success" ? 1 : 0;
    tx.insert(dailySpend)
      .values({
        id: generateId(),
        projectId: event.projectId,
        apiKey: event.apiKey,
        date: startTime.slice(0, 10),
        model: event.model || "",
        modelGroup: event.modelGroup || null,
        provider: event.provider || "",
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        spend: event.spend,
        apiRequests: 1,
        successfulRequests: success,
        failedRequests: 1 - success,
      })
      .onConflictDoUpdate({
        target: [
          dailySpend.projectId,
          dailySpend.apiKey,
          dailySpend.date,
          dailySpend.model,
          dailySpend.provider,
        ],
        set: {
          promptTokens: sql`${dailySpend.promptTokens} + ${event.promptTokens}`,
          completionTokens: sql`${dailySpend.completionTokens} + ${event.completionTokens}`,
          spend: sql`${dailySpend.spend} + ${event.spend}`,
          apiRequests: sql`${dailySpend.apiRequests} + 1`,
          successfulRequests: sql`${dailySpend.successfulRequests} + ${success}`,
          failedRequests: sql`${dailySpend.failedRequests} + ${1 - success}`,
        },
      })
      .run();

    if (event.apiKey) {
      tx.update(apiKey)
        .set({ spend: sql`${apiKey.spend} + ${event.spend}`, lastActive: endTime })
        .where(and(eq(apiKey.projectId, event.projectId), eq(apiKey.publicKey, event.apiKey)))
        .run();
    }
  });
}
