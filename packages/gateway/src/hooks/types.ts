/**
 * Gateway Hook system types (inspired by LiteLLM CustomLogger).
 */

export interface ApiKeyRecord {
  id: string;
  publicKey: string;
  spend: number;
  models: string[];
  maxParallel: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  maxBudget: number | null;
  budgetId: string | null;
  metadata: Record<string, unknown>;
}

export interface HookContext {
  apiKey: ApiKeyRecord;
  model: string;
  protocol: "openai" | "anthropic";
  callType: "chat" | "messages" | "embeddings";
  messages?: unknown[];
  stream: boolean;
  startTime: Date;
  metadata: Record<string, unknown>;
}

export interface CallResult {
  response: unknown;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  spend: number;
  latencyMs: number;
  ttftMs?: number;
  providerId: string;
  providerModel: string;
  apiBase: string;
}

export interface GatewayHook {
  name: string;
  /** Pre-request check. Throw to reject the request (e.g. 429, 402). */
  preCall?(ctx: HookContext): Promise<void>;
  /** Post-success handler (async, does not block response). */
  postSuccess?(ctx: HookContext, result: CallResult): Promise<void>;
  /** Post-failure handler. */
  postFailure?(ctx: HookContext, error: Error): Promise<void>;
}

/** Error thrown by hooks to reject a request with a specific HTTP status. */
export class HookRejectError extends Error {
  statusCode: number;
  retryAfter?: number;

  constructor(message: string, statusCode: number, retryAfter?: number) {
    super(message);
    this.name = "HookRejectError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}
