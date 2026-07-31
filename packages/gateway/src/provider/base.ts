/**
 * Base provider adapter interface.
 * Each provider type implements this to handle request/response transformation.
 */
import type { PeriRequest, PeriResponse, PeriStreamChunk, PeriUsage } from "../protocol/types.js";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface ProviderCallResult {
  response?: PeriResponse;
  stream?: AsyncIterable<PeriStreamChunk>;
  usage: PeriUsage;
  ttftMs?: number;
  rawHeaders?: Record<string, string>;
}

export abstract class BaseProviderAdapter {
  abstract readonly type: string;

  constructor(protected config: ProviderConfig) {}

  /**
   * Transform PeriRequest into provider-specific request body.
   */
  abstract transformRequest(req: PeriRequest, providerModel: string): Record<string, unknown>;

  /**
   * Transform provider response into PeriResponse.
   */
  abstract transformResponse(raw: unknown, providerModel: string): PeriResponse;

  /**
   * Transform a streaming chunk from the provider into PeriStreamChunk.
   */
  abstract transformStreamChunk(raw: unknown, providerModel: string): PeriStreamChunk | null;

  /**
   * Get the headers required for the provider API call.
   */
  abstract getHeaders(): Record<string, string>;

  /**
   * Get the full URL for the API endpoint.
   */
  abstract getEndpointUrl(callType: string): string;

  /**
   * Execute a non-streaming request.
   */
  async call(req: PeriRequest, providerModel: string): Promise<ProviderCallResult> {
    const url = this.getEndpointUrl("chat");
    const body = this.transformRequest(req, providerModel);
    const startTime = Date.now();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.getHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new ProviderError(
        `Provider ${this.type} returned ${res.status}: ${errorBody}`,
        res.status,
        errorBody,
      );
    }

    const raw = await res.json();
    const response = this.transformResponse(raw, providerModel);
    const latencyMs = Date.now() - startTime;

    return {
      response,
      usage: response.usage,
      ttftMs: latencyMs,
    };
  }

  /**
   * Execute a streaming request. Returns an async iterable of chunks.
   */
  async callStream(req: PeriRequest, providerModel: string): Promise<ProviderCallResult> {
    const url = this.getEndpointUrl("chat");
    const body = this.transformRequest({ ...req, stream: true }, providerModel);
    const startTime = Date.now();
    let firstChunkTime: number | undefined;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.getHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 300_000),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new ProviderError(
        `Provider ${this.type} returned ${res.status}: ${errorBody}`,
        res.status,
        errorBody,
      );
    }

    if (!res.body) {
      throw new ProviderError("Provider returned empty body for stream", 502, "");
    }

    const adapter = this;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const usage: PeriUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    async function* generateChunks(): AsyncIterable<PeriStreamChunk> {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;

            try {
              const parsed = JSON.parse(data);
              if (!firstChunkTime) {
                firstChunkTime = Date.now();
              }
              const chunk = adapter.transformStreamChunk(parsed, providerModel);
              if (chunk) {
                if (chunk.usage) {
                  usage.promptTokens = chunk.usage.promptTokens;
                  usage.completionTokens = chunk.usage.completionTokens;
                  usage.totalTokens = chunk.usage.totalTokens;
                }
                yield chunk;
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    return {
      stream: generateChunks(),
      usage,
      get ttftMs() {
        return firstChunkTime ? firstChunkTime - startTime : undefined;
      },
    };
  }
}

export class ProviderError extends Error {
  statusCode: number;
  responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}
