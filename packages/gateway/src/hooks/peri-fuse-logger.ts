/**
 * PeriFuse logger hook — async trace reporting to PeriFuse (Langfuse-compatible).
 * Non-blocking: errors are logged but never propagate to the caller.
 */

import { gatewayEnv } from "../env.js";
import { createAbortScope } from "../provider/lifecycle.js";
import { generateId } from "../utils/id.js";
import { logSnapshot } from "../utils/log-snapshot.js";
import type { CallResult, GatewayHook, HookContext } from "./types.js";

const MAX_CONCURRENT_REPORTS = 8;
let activeReports = 0;
let droppedReports = 0;
export const periFuseLoggerStats = () => ({ activeReports, droppedReports });
const snapshot = (value: unknown) => logSnapshot(value, gatewayEnv.logMaxBodySize);

function metadataSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const result = snapshot(value);
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { _truncated: true };
}

function admitReport(): boolean {
  if (!isConfigured() || !gatewayEnv.logRequests) return false;
  if (activeReports >= MAX_CONCURRENT_REPORTS) {
    droppedReports++;
    if (droppedReports === 1 || droppedReports % 1000 === 0) {
      console.warn(`[peri-fuse-logger] Reporting saturated; ${droppedReports} traces skipped`);
    }
    return false;
  }
  activeReports++;
  return true;
}

export const periFuseLoggerHook: GatewayHook = {
  name: "peri-fuse-logger",

  postSuccess(ctx: HookContext, result: CallResult): Promise<void> {
    if (!admitReport()) return Promise.resolve();
    try {
      const traceId = generateId();
      const generationId = generateId();

      const batch = [
        {
          id: generateId(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: {
            id: traceId,
            name: `gw:${ctx.model.slice(0, 256)}`,
            userId: ctx.apiKey.publicKey,
            metadata: {
              ...metadataSnapshot(ctx.metadata),
              projectId: ctx.projectId,
              protocol: ctx.protocol,
              callType: ctx.callType,
              stream: ctx.stream,
            },
            tags: ["gateway"],
          },
        },
        {
          id: generateId(),
          type: "generation-create",
          timestamp: new Date().toISOString(),
          body: {
            id: generationId,
            traceId,
            name: ctx.model.slice(0, 256),
            model: result.providerModel.slice(0, 256),
            modelParameters: {
              stream: ctx.stream,
            },
            input: snapshot(ctx.messages),
            output: snapshot(result.response),
            usage: {
              input: result.promptTokens,
              output: result.completionTokens,
              total: result.totalTokens,
            },
            metadata: {
              providerId: result.providerId,
              apiBase: result.apiBase.slice(0, 2048),
              latencyMs: result.latencyMs,
              ttftMs: result.ttftMs,
              spend: result.spend,
            },
            startTime: ctx.startTime.toISOString(),
            endTime: new Date().toISOString(),
            completionStartTime: result.ttftMs
              ? new Date(ctx.startTime.getTime() + result.ttftMs).toISOString()
              : undefined,
            level: "DEFAULT",
            statusMessage: "success",
          },
        },
      ];

      return sendToPeriFuse(batch);
    } catch (error) {
      activeReports--;
      return Promise.reject(error);
    }
  },

  postFailure(ctx: HookContext, error: Error): Promise<void> {
    if (!admitReport()) return Promise.resolve();
    try {
      const traceId = generateId();

      const batch = [
        {
          id: generateId(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: {
            id: traceId,
            name: `gw:${ctx.model.slice(0, 256)}`,
            userId: ctx.apiKey.publicKey,
            metadata: {
              projectId: ctx.projectId,
              protocol: ctx.protocol,
              callType: ctx.callType,
              error: snapshot(error.message),
            },
            tags: ["gateway", "error"],
          },
        },
        {
          id: generateId(),
          type: "generation-create",
          timestamp: new Date().toISOString(),
          body: {
            id: generateId(),
            traceId,
            name: ctx.model.slice(0, 256),
            input: snapshot(ctx.messages),
            startTime: ctx.startTime.toISOString(),
            endTime: new Date().toISOString(),
            level: "ERROR",
            statusMessage: snapshot(error.message),
          },
        },
      ];

      return sendToPeriFuse(batch);
    } catch (error) {
      activeReports--;
      return Promise.reject(error);
    }
  },
};

function isConfigured(): boolean {
  return !!(
    gatewayEnv.perifuseEndpoint &&
    gatewayEnv.perifusePublicKey &&
    gatewayEnv.perifuseSecretKey
  );
}

async function sendToPeriFuse(batch: unknown[]): Promise<void> {
  const scope = createAbortScope(5000);
  try {
    const url = `${gatewayEnv.perifuseEndpoint}/api/public/ingestion`;
    const auth = Buffer.from(
      `${gatewayEnv.perifusePublicKey}:${gatewayEnv.perifuseSecretKey}`,
    ).toString("base64");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ batch }),
      signal: scope.signal,
    });

    try {
      if (!res.ok) {
        console.warn(`[peri-fuse-logger] Ingestion failed: ${res.status} ${res.statusText}`);
      }
    } finally {
      await res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    console.warn("[peri-fuse-logger] Failed to send trace:", err);
  } finally {
    scope.dispose();
    activeReports--;
  }
}
