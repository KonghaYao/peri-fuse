/**
 * PeriFuse logger hook — async trace reporting to PeriFuse (Langfuse-compatible).
 * Non-blocking: errors are logged but never propagate to the caller.
 */
import type { CallResult, GatewayHook, HookContext } from "./types.js";
import { gatewayEnv } from "../env.js";
import { generateId } from "../utils/id.js";

export const periFuseLoggerHook: GatewayHook = {
  name: "peri-fuse-logger",

  async postSuccess(ctx: HookContext, result: CallResult): Promise<void> {
    if (!isConfigured()) return;

    const traceId = generateId();
    const generationId = generateId();

    const batch = [
      {
        id: generateId(),
        type: "trace-create",
        timestamp: new Date().toISOString(),
        body: {
          id: traceId,
          name: `gw:${ctx.model}`,
          userId: ctx.apiKey.publicKey,
          metadata: {
            protocol: ctx.protocol,
            callType: ctx.callType,
            stream: ctx.stream,
            ...ctx.metadata,
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
          name: ctx.model,
          model: result.providerModel,
          modelParameters: {
            stream: ctx.stream,
          },
          input: ctx.messages,
          output: result.response,
          usage: {
            input: result.promptTokens,
            output: result.completionTokens,
            total: result.totalTokens,
          },
          metadata: {
            providerId: result.providerId,
            apiBase: result.apiBase,
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

    await sendToPeriFuse(batch);
  },

  async postFailure(ctx: HookContext, error: Error): Promise<void> {
    if (!isConfigured()) return;

    const traceId = generateId();

    const batch = [
      {
        id: generateId(),
        type: "trace-create",
        timestamp: new Date().toISOString(),
        body: {
          id: traceId,
          name: `gw:${ctx.model}`,
          userId: ctx.apiKey.publicKey,
          metadata: {
            protocol: ctx.protocol,
            callType: ctx.callType,
            error: error.message,
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
          name: ctx.model,
          input: ctx.messages,
          startTime: ctx.startTime.toISOString(),
          endTime: new Date().toISOString(),
          level: "ERROR",
          statusMessage: error.message,
        },
      },
    ];

    await sendToPeriFuse(batch);
  },
};

function isConfigured(): boolean {
  return !!(gatewayEnv.perifuseEndpoint && gatewayEnv.perifusePublicKey && gatewayEnv.perifuseSecretKey);
}

async function sendToPeriFuse(batch: unknown[]): Promise<void> {
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
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[peri-fuse-logger] Ingestion failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn("[peri-fuse-logger] Failed to send trace:", err);
  }
}
