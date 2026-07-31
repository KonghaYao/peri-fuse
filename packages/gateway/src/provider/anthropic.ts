/**
 * Anthropic provider adapter.
 * Handles the Anthropic Messages API format.
 */
import type { PeriMessage, PeriRequest, PeriResponse, PeriStreamChunk } from "../protocol/types.js";
import { BaseProviderAdapter, type ProviderConfig } from "./base.js";

export class AnthropicAdapter extends BaseProviderAdapter {
  readonly type = "anthropic";

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || "https://api.anthropic.com",
    });
  }

  getHeaders(): Record<string, string> {
    return {
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  getEndpointUrl(_callType: string): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    return `${base}/v1/messages`;
  }

  transformRequest(req: PeriRequest, providerModel: string): Record<string, unknown> {
    // Anthropic uses a separate `system` param, not a message role
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: providerModel,
      messages: nonSystemMessages.map((m) => this.transformMessage(m)),
      max_tokens: req.maxTokens ?? 4096,
      stream: req.stream,
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n\n");
    }
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.topP != null) body.top_p = req.topP;
    if (req.stop != null) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
    }
    if (req.metadata) body.metadata = req.metadata;

    return body;
  }

  transformResponse(raw: any, providerModel: string): PeriResponse {
    const content = raw.content ?? [];
    const textContent = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");

    const message: PeriMessage = {
      role: "assistant",
      content: textContent || null,
    };

    if (toolUseBlocks.length > 0) {
      message.toolCalls = toolUseBlocks.map((b: any) => ({
        id: b.id,
        type: "function" as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));
    }

    return {
      id: raw.id ?? "",
      model: raw.model ?? providerModel,
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message,
          finishReason: this.mapStopReason(raw.stop_reason),
        },
      ],
      usage: {
        promptTokens: raw.usage?.input_tokens ?? 0,
        completionTokens: raw.usage?.output_tokens ?? 0,
        totalTokens: (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
      },
    };
  }

  transformStreamChunk(raw: any, providerModel: string): PeriStreamChunk | null {
    switch (raw.type) {
      case "content_block_delta": {
        const delta = raw.delta;
        if (delta?.type === "text_delta") {
          return {
            id: "",
            model: providerModel,
            delta: { content: delta.text },
            finishReason: null,
          };
        }
        if (delta?.type === "input_json_delta") {
          return {
            id: "",
            model: providerModel,
            delta: {
              toolCalls: [
                {
                  id: "",
                  type: "function",
                  function: { name: "", arguments: delta.partial_json ?? "" },
                },
              ],
            },
            finishReason: null,
          };
        }
        return null;
      }

      case "message_delta": {
        return {
          id: "",
          model: providerModel,
          delta: {},
          finishReason: this.mapStopReason(raw.delta?.stop_reason),
          usage: raw.usage
            ? {
                promptTokens: 0,
                completionTokens: raw.usage.output_tokens ?? 0,
                totalTokens: raw.usage.output_tokens ?? 0,
              }
            : undefined,
        };
      }

      case "message_start": {
        const usage = raw.message?.usage;
        return {
          id: raw.message?.id ?? "",
          model: raw.message?.model ?? providerModel,
          delta: { role: "assistant" },
          finishReason: null,
          usage: usage
            ? {
                promptTokens: usage.input_tokens ?? 0,
                completionTokens: 0,
                totalTokens: usage.input_tokens ?? 0,
              }
            : undefined,
        };
      }

      default:
        return null;
    }
  }

  private transformMessage(msg: PeriMessage): Record<string, unknown> {
    if (msg.role === "tool" && msg.toolCallId) {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: typeof msg.content === "string" ? msg.content : "",
          },
        ],
      };
    }

    // Assistant message with tool calls
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const content: any[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      return { role: "assistant", content };
    }

    return {
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content ?? "",
    };
  }

  private mapStopReason(reason: string | null | undefined): string | null {
    switch (reason) {
      case "end_turn":
        return "stop";
      case "max_tokens":
        return "length";
      case "tool_use":
        return "tool_calls";
      case "stop_sequence":
        return "stop";
      default:
        return reason ?? null;
    }
  }
}
