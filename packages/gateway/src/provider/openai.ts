/**
 * OpenAI-compatible provider adapter.
 * Works with OpenAI, Azure OpenAI, Ollama, vLLM, and any OpenAI-compatible endpoint.
 */
import type { PeriMessage, PeriRequest, PeriResponse, PeriStreamChunk } from "../protocol/types.js";
import { BaseProviderAdapter, type ProviderConfig } from "./base.js";

export class OpenAIAdapter extends BaseProviderAdapter {
  readonly type = "openai";

  constructor(config: ProviderConfig) {
    super(config);
  }

  getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  getEndpointUrl(callType: string): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    switch (callType) {
      case "embeddings":
        return `${base}/embeddings`;
      default:
        return `${base}/chat/completions`;
    }
  }

  transformRequest(req: PeriRequest, providerModel: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: providerModel,
      messages: req.messages.map((m) => this.transformMessage(m)),
      stream: req.stream,
    };

    if (req.maxTokens != null) body.max_tokens = req.maxTokens;
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.topP != null) body.top_p = req.topP;
    if (req.stop != null) body.stop = req.stop;
    if (req.tools?.length) body.tools = req.tools;
    if (req.toolChoice != null) body.tool_choice = req.toolChoice;
    if (req.user) body.user = req.user;
    if (req.stream) body.stream_options = { include_usage: true };

    // Merge extra params
    if (req.extra) Object.assign(body, req.extra);

    return body;
  }

  transformResponse(raw: any, providerModel: string): PeriResponse {
    return {
      id: raw.id ?? "",
      model: raw.model ?? providerModel,
      created: raw.created ?? Math.floor(Date.now() / 1000),
      choices: (raw.choices ?? []).map((c: any) => ({
        index: c.index ?? 0,
        message: {
          role: c.message?.role ?? "assistant",
          content: c.message?.content ?? null,
          toolCalls: c.message?.tool_calls,
        },
        finishReason: c.finish_reason ?? null,
      })),
      usage: {
        promptTokens: raw.usage?.prompt_tokens ?? 0,
        completionTokens: raw.usage?.completion_tokens ?? 0,
        totalTokens: raw.usage?.total_tokens ?? 0,
      },
    };
  }

  transformStreamChunk(raw: any, providerModel: string): PeriStreamChunk | null {
    // Usage-only chunk (stream_options.include_usage)
    if (raw.usage && !raw.choices?.length) {
      return {
        id: raw.id ?? "",
        model: raw.model ?? providerModel,
        delta: {},
        finishReason: null,
        usage: {
          promptTokens: raw.usage.prompt_tokens ?? 0,
          completionTokens: raw.usage.completion_tokens ?? 0,
          totalTokens: raw.usage.total_tokens ?? 0,
        },
      };
    }

    const choice = raw.choices?.[0];
    if (!choice) return null;

    return {
      id: raw.id ?? "",
      model: raw.model ?? providerModel,
      delta: {
        role: choice.delta?.role,
        content: choice.delta?.content ?? undefined,
        toolCalls: choice.delta?.tool_calls,
      },
      finishReason: choice.finish_reason ?? null,
      // Attach usage if present (some providers include it in the final chunk)
      ...(raw.usage ? {
        usage: {
          promptTokens: raw.usage.prompt_tokens ?? 0,
          completionTokens: raw.usage.completion_tokens ?? 0,
          totalTokens: raw.usage.total_tokens ?? 0,
        },
      } : {}),
    };
  }

  private transformMessage(msg: PeriMessage): Record<string, unknown> {
    const result: Record<string, unknown> = { role: msg.role };
    if (msg.content != null) result.content = msg.content;
    if (msg.name) result.name = msg.name;
    if (msg.toolCalls) result.tool_calls = msg.toolCalls;
    if (msg.toolCallId) result.tool_call_id = msg.toolCallId;
    return result;
  }
}
