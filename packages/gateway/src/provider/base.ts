/**
 * Base provider adapter interface.
 * Each provider type implements this to handle request/response transformation.
 */

import type { PeriRequest, PeriResponse, PeriStreamChunk, PeriUsage } from "../protocol/types.js";
import { createAbortScope, readBoundedText } from "./lifecycle.js";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  maxSseLineBytes?: number;
}

export interface ProviderCallResult {
  response?: PeriResponse;
  stream?: AsyncIterable<PeriStreamChunk>;
  usage: PeriUsage;
  ttftMs?: number;
  rawHeaders?: Record<string, string>;
  /** Release an unconsumed or interrupted upstream stream. */
  cancel?: () => void;
  signal?: AbortSignal;
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

    const scope = createAbortScope(this.config.timeout ?? 120_000, this.config.signal);
    try {
      scope.signal.throwIfAborted();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getHeaders() },
        body: JSON.stringify(body),
        signal: scope.signal,
      });
      if (!res.ok) {
        const errorBody = await readBoundedText(res, 64 * 1024, scope.signal, true);
        throw new ProviderError(
          `Provider ${this.type} returned ${res.status}: ${errorBody}`,
          res.status,
          errorBody,
        );
      }
      const raw = JSON.parse(
        await readBoundedText(res, this.config.maxResponseBytes ?? 32 * 1024 * 1024, scope.signal),
      );
      const response = this.transformResponse(raw, providerModel);
      return { response, usage: response.usage, ttftMs: Date.now() - startTime };
    } finally {
      scope.dispose();
    }
  }

  /**
   * Execute a streaming request. Returns an async iterable of chunks.
   */
  async callStream(req: PeriRequest, providerModel: string): Promise<ProviderCallResult> {
    const url = this.getEndpointUrl("chat");
    const body = this.transformRequest({ ...req, stream: true }, providerModel);
    const startTime = Date.now();
    let firstChunkTime: number | undefined;

    const scope = createAbortScope(this.config.timeout ?? 300_000, this.config.signal);
    let res: Response;
    try {
      scope.signal.throwIfAborted();
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getHeaders() },
        body: JSON.stringify(body),
        signal: scope.signal,
      });
      if (!res.ok) {
        const errorBody = await readBoundedText(res, 64 * 1024, scope.signal, true);
        throw new ProviderError(
          `Provider ${this.type} returned ${res.status}: ${errorBody}`,
          res.status,
          errorBody,
        );
      }
      if (!res.body) throw new ProviderError("Provider returned empty body for stream", 502, "");
    } catch (error) {
      scope.dispose();
      throw error;
    }

    const adapter = this;
    const reader = res.body.getReader();
    let released = false;
    let started = false;
    const cancelReader = () => {
      if (!released) void reader.cancel().catch(() => {});
    };
    scope.signal.addEventListener("abort", cancelReader, { once: true });
    const maxLineBytes = this.config.maxSseLineBytes ?? 1024 * 1024;
    const decoder = new TextDecoder();
    let buffer = "";
    const usage: PeriUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    async function* generateChunks(): AsyncIterable<PeriStreamChunk> {
      started = true;
      try {
        while (true) {
          scope.signal.throwIfAborted();
          const { done, value } = await reader.read();
          scope.signal.throwIfAborted();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          if (Buffer.byteLength(buffer) > maxLineBytes) {
            throw new ProviderError("Provider SSE line exceeds size limit", 502, "");
          }
          for (const line of lines) {
            if (Buffer.byteLength(line) > maxLineBytes) {
              throw new ProviderError("Provider SSE line exceeds size limit", 502, "");
            }
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
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
        scope.signal.removeEventListener("abort", cancelReader);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        released = true;
        buffer = "";
        scope.dispose();
      }
    }

    return {
      stream: generateChunks(),
      signal: scope.signal,
      cancel() {
        scope.abort();
        if (!started && !released) {
          void reader
            .cancel()
            .catch(() => {})
            .finally(() => {
              if (!started && !released) {
                reader.releaseLock();
                released = true;
              }
            });
        }
        scope.signal.removeEventListener("abort", cancelReader);
        scope.dispose();
      },
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
