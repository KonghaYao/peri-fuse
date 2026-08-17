/**
 * POST /v1/chat/completions — OpenAI-compatible chat endpoint.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { GatewayEnv } from "../../app.js";
import { hookRegistry } from "../../hooks/registry.js";
import type { HookContext } from "../../hooks/types.js";
import type { PeriRequest } from "../../protocol/types.js";
import { routeRequest, RouterError } from "../../router/index.js";
import { ProviderError } from "../../provider/base.js";
import { spendFlusher } from "../../spend/flusher.js";
import { calculateCost } from "../../spend/calculator.js";

const chat = new Hono<GatewayEnv>();

chat.post("/v1/chat/completions", async (c) => {
  const startTime = new Date();
  const body = await c.req.json();
  const projectId = c.get("projectId");

  // Build PeriRequest
  const req: PeriRequest = {
    model: body.model,
    messages: body.messages ?? [],
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stream: body.stream ?? false,
    stop: body.stop,
    tools: body.tools,
    toolChoice: body.tool_choice,
    user: body.user,
    metadata: body.metadata,
    extra: extractExtra(body),
  };

  // Build hook context
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
    protocol: "openai",
    callType: "chat",
    messages: req.messages,
    stream: req.stream,
    startTime,
    metadata: req.metadata ?? {},
  };

  // Run pre-call hooks (rate limiting, budget checks)
  try {
    await hookRegistry.runPreCall(hookCtx);
  } catch (err: any) {
    const status = err.statusCode ?? 429;
    const headers: Record<string, string> = {};
    if (err.retryAfter) headers["Retry-After"] = String(err.retryAfter);
    return c.json({ error: { message: err.message, type: "rate_limit_error" } }, status, headers);
  }

  // Route the request
  try {
    const result = await routeRequest(req, projectId);
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();

    if (req.stream && result.stream) {
      // Streaming response
      const chunkStream = result.stream;
      return streamSSE(c, async (stream) => {
        let completionTokens = 0;
        let ttftMs: number | undefined;
        const chunkStartTime = Date.now();

        for await (const chunk of chunkStream) {
          if (!ttftMs) ttftMs = Date.now() - chunkStartTime;

          // Format as OpenAI SSE chunk
          const sseData = {
            id: chunk.id || `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: result.deployment.providerModel,
            choices: [
              {
                index: 0,
                delta: {
                  ...(chunk.delta.role ? { role: chunk.delta.role } : {}),
                  ...(chunk.delta.content != null ? { content: chunk.delta.content } : {}),
                  ...(chunk.delta.toolCalls ? { tool_calls: chunk.delta.toolCalls } : {}),
                },
                finish_reason: chunk.finishReason,
              },
            ],
            ...(chunk.usage ? { usage: chunk.usage } : {}),
          };

          await stream.writeSSE({ data: JSON.stringify(sseData) });

          if (chunk.usage) {
            completionTokens = chunk.usage.completionTokens;
          }
        }

        await stream.writeSSE({ data: "[DONE]" });

        // Post-call tracking
        const usage = result.usage;
        const spend = calculateCost(
          usage.promptTokens,
          usage.completionTokens,
          result.deployment.modelInfo,
        );

        spendFlusher.enqueue({
          projectId,
          callType: "chat",
          apiKey: hookCtx.apiKey.publicKey,
          spend,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          startTime,
          endTime: new Date(),
          completionStartTime: ttftMs ? new Date(startTime.getTime() + ttftMs) : undefined,
          requestDurationMs: Date.now() - startTime.getTime(),
          model: result.deployment.providerModel,
          modelId: result.deployment.id,
          modelGroup: req.model,
          provider: result.deployment.providerName,
          apiBase: result.deployment.baseUrl,
          protocol: "openai",
          stream: req.stream,
          status: "success",
        });

        hookRegistry.runPostSuccess(hookCtx, {
          response: null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          spend,
          latencyMs: Date.now() - startTime.getTime(),
          ttftMs,
          providerId: result.deployment.providerId,
          providerModel: result.deployment.providerModel,
          apiBase: result.deployment.baseUrl,
        });
      });
    }

    // Non-streaming response
    const response = result.response!;
    const spend = calculateCost(
      response.usage.promptTokens,
      response.usage.completionTokens,
      result.deployment.modelInfo,
    );

    // Format as OpenAI response
    const openaiResponse = {
      id: response.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: response.created,
      model: result.deployment.providerModel,
      choices: response.choices.map((ch) => ({
        index: ch.index,
        message: {
          role: ch.message.role,
          content: ch.message.content,
          ...(ch.message.toolCalls ? { tool_calls: ch.message.toolCalls } : {}),
        },
        finish_reason: ch.finishReason,
      })),
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
      },
    };

    // Track spend
    spendFlusher.enqueue({
      projectId,
      callType: "chat",
      apiKey: hookCtx.apiKey.publicKey,
      spend,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      startTime,
      endTime,
      requestDurationMs: latencyMs,
      model: result.deployment.providerModel,
      modelId: result.deployment.id,
      modelGroup: req.model,
      provider: result.deployment.providerName,
      apiBase: result.deployment.baseUrl,
      protocol: "openai",
      stream: req.stream,
      status: "success",
    });

    hookRegistry.runPostSuccess(hookCtx, {
      response: openaiResponse,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      spend,
      latencyMs,
      ttftMs: result.ttftMs,
      providerId: result.deployment.providerId,
      providerModel: result.deployment.providerModel,
      apiBase: result.deployment.baseUrl,
    });

    return c.json(openaiResponse);
  } catch (err) {
    hookRegistry.runPostFailure(hookCtx, err instanceof Error ? err : new Error(String(err)));

    if (err instanceof RouterError) {
      return c.json({ error: { message: err.message, type: "router_error" } }, err.statusCode as 502);
    }
    if (err instanceof ProviderError) {
      return c.json(
        { error: { message: err.message, type: "provider_error" } },
        err.statusCode as 502,
      );
    }

    const message = err instanceof Error ? err.message : "Internal error";
    return c.json({ error: { message, type: "internal_error" } }, 500);
  }
});

function extractExtra(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const known = new Set([
    "model", "messages", "max_tokens", "max_completion_tokens", "temperature",
    "top_p", "stream", "stop", "tools", "tool_choice", "user", "metadata",
    "stream_options", "n", "presence_penalty", "frequency_penalty", "logit_bias",
  ]);
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) {
      extra[key] = value;
      hasExtra = true;
    }
  }
  return hasExtra ? extra : undefined;
}

export default chat;
