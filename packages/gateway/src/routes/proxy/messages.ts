/**
 * POST /v1/messages — Anthropic Messages API compatible endpoint.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { GatewayEnv } from "../../app.js";
import { hookRegistry } from "../../hooks/registry.js";
import type { HookContext } from "../../hooks/types.js";
import type { PeriMessage, PeriRequest } from "../../protocol/types.js";
import { routeRequest, RouterError } from "../../router/index.js";
import { ProviderError } from "../../provider/base.js";
import { spendFlusher } from "../../spend/flusher.js";
import { calculateCost } from "../../spend/calculator.js";

const messages = new Hono<GatewayEnv>();

messages.post("/v1/messages", async (c) => {
  const startTime = new Date();
  const body = await c.req.json();
  const projectId = c.get("projectId");

  // Convert Anthropic format to PeriRequest
  const periMessages: PeriMessage[] = [];

  // System message
  if (body.system) {
    periMessages.push({
      role: "system",
      content: typeof body.system === "string" ? body.system : JSON.stringify(body.system),
    });
  }

  // Convert messages
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      periMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Handle content blocks (text, tool_result, tool_use)
      const textParts = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text);
      const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
      const toolUses = msg.content.filter((b: any) => b.type === "tool_use");

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          periMessages.push({
            role: "tool",
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
            toolCallId: tr.tool_use_id,
          });
        }
      } else if (toolUses.length > 0) {
        periMessages.push({
          role: "assistant",
          content: textParts.join("") || null,
          toolCalls: toolUses.map((tu: any) => ({
            id: tu.id,
            type: "function" as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          })),
        });
      } else {
        periMessages.push({ role: msg.role, content: textParts.join("") });
      }
    }
  }

  const req: PeriRequest = {
    model: body.model,
    messages: periMessages,
    maxTokens: body.max_tokens ?? 4096,
    temperature: body.temperature,
    topP: body.top_p,
    stream: body.stream ?? false,
    stop: body.stop_sequences,
    tools: body.tools?.map((t: any) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    metadata: body.metadata,
  };

  const keyRecord = c.get("apiKeyRecord");
  const hookCtx: HookContext = {
    projectId,
    apiKey: {
      id: keyRecord?.id ?? c.get("apiKeyId") ?? "",
      publicKey: keyRecord?.publicKey ?? c.get("apiKeyPrefix") ?? "",
      spend: keyRecord?.spend ?? 0,
      models: keyRecord?.models ? JSON.parse(keyRecord.models) : [],
      maxParallel: keyRecord?.maxParallel ?? null,
      tpmLimit: keyRecord?.tpmLimit ?? null,
      rpmLimit: keyRecord?.rpmLimit ?? null,
      maxBudget: keyRecord?.maxBudget ?? null,
      budgetId: keyRecord?.budgetId ?? null,
      metadata: keyRecord?.metadata ? JSON.parse(keyRecord.metadata) : {},
    },
    model: req.model,
    protocol: "anthropic",
    callType: "messages",
    messages: periMessages,
    stream: req.stream,
    startTime,
    metadata: req.metadata ?? {},
  };

  // Pre-call hooks
  try {
    await hookRegistry.runPreCall(hookCtx);
  } catch (err: any) {
    const status = err.statusCode ?? 429;
    return c.json({ type: "error", error: { type: "rate_limit_error", message: err.message } }, status);
  }

  try {
    const result = await routeRequest(req, projectId);
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();

    if (req.stream && result.stream) {
      const chunkStream = result.stream;
      // Anthropic SSE streaming
      return streamSSE(c, async (stream) => {
        let ttftMs: number | undefined;
        const chunkStartTime = Date.now();

        // Send message_start
        await stream.writeSSE({
          event: "message_start",
          data: JSON.stringify({
            type: "message_start",
            message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: result.deployment.providerModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
          }),
        });
        await stream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        });

        for await (const chunk of chunkStream) {
          if (!ttftMs) ttftMs = Date.now() - chunkStartTime;

          if (chunk.delta.content) {
            await stream.writeSSE({
              event: "content_block_delta",
              data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk.delta.content } }),
            });
          }
        }

        await stream.writeSSE({
          event: "content_block_stop",
          data: JSON.stringify({ type: "content_block_stop", index: 0 }),
        });
        await stream.writeSSE({
          event: "message_delta",
          data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: result.usage.completionTokens } }),
        });
        await stream.writeSSE({
          event: "message_stop",
          data: JSON.stringify({ type: "message_stop" }),
        });

        // Track spend
        const spend = calculateCost(result.usage.promptTokens, result.usage.completionTokens, result.deployment.modelInfo);
        spendFlusher.enqueue({
          projectId,
          callType: "messages", apiKey: hookCtx.apiKey.publicKey, spend,
          promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens, startTime, endTime: new Date(),
          completionStartTime: ttftMs ? new Date(startTime.getTime() + ttftMs) : undefined,
          requestDurationMs: Date.now() - startTime.getTime(),
          model: result.deployment.providerModel, modelId: result.deployment.id,
          modelGroup: req.model, provider: result.deployment.providerName,
          apiBase: result.deployment.baseUrl, protocol: "anthropic", stream: req.stream, status: "success",
        });

        hookRegistry.runPostSuccess(hookCtx, {
          response: null, promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens,
          spend, latencyMs: Date.now() - startTime.getTime(), ttftMs,
          providerId: result.deployment.providerId, providerModel: result.deployment.providerModel,
          apiBase: result.deployment.baseUrl,
        });
      });
    }

    // Non-streaming Anthropic response
    const response = result.response!;
    const spend = calculateCost(response.usage.promptTokens, response.usage.completionTokens, result.deployment.modelInfo);

    const anthropicResponse = {
      id: response.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: result.deployment.providerModel,
      content: response.choices[0]?.message.toolCalls
        ? [
            ...(response.choices[0]?.message.content ? [{ type: "text", text: response.choices[0].message.content }] : []),
            ...response.choices[0].message.toolCalls.map((tc) => ({
              type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}"),
            })),
          ]
        : [{ type: "text", text: response.choices[0]?.message.content ?? "" }],
      stop_reason: mapFinishReason(response.choices[0]?.finishReason),
      stop_sequence: null,
      usage: { input_tokens: response.usage.promptTokens, output_tokens: response.usage.completionTokens },
    };

    spendFlusher.enqueue({
      projectId,
      callType: "messages", apiKey: hookCtx.apiKey.publicKey, spend,
      promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens, startTime, endTime,
      requestDurationMs: latencyMs, model: result.deployment.providerModel,
      modelId: result.deployment.id, modelGroup: req.model,
      provider: result.deployment.providerName, apiBase: result.deployment.baseUrl,
      protocol: "anthropic", stream: req.stream, status: "success",
    });

    hookRegistry.runPostSuccess(hookCtx, {
      response: anthropicResponse, promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens, totalTokens: response.usage.totalTokens,
      spend, latencyMs, ttftMs: result.ttftMs,
      providerId: result.deployment.providerId, providerModel: result.deployment.providerModel,
      apiBase: result.deployment.baseUrl,
    });

    return c.json(anthropicResponse);
  } catch (err) {
    hookRegistry.runPostFailure(hookCtx, err instanceof Error ? err : new Error(String(err)));
    if (err instanceof RouterError) {
      return c.json({ type: "error", error: { type: "api_error", message: err.message } }, err.statusCode as 502);
    }
    if (err instanceof ProviderError) {
      return c.json({ type: "error", error: { type: "api_error", message: err.message } }, err.statusCode as 502);
    }
    return c.json({ type: "error", error: { type: "api_error", message: "Internal error" } }, 500);
  }
});

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

export default messages;
