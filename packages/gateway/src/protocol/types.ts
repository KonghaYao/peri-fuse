/**
 * Unified internal request/response types for PeriGateway.
 * All inbound protocols are normalized to PeriRequest,
 * and all outbound provider responses are normalized to PeriResponse.
 */

export interface PeriMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  imageUrl?: { url: string; detail?: string };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface PeriTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface PeriRequest {
  model: string;
  messages: PeriMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream: boolean;
  stop?: string | string[];
  tools?: PeriTool[];
  toolChoice?: string | { type: "function"; function: { name: string } };
  user?: string;
  metadata?: Record<string, unknown>;
  // Passthrough fields for provider-specific params
  extra?: Record<string, unknown>;
}

export interface PeriUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface PeriChoice {
  index: number;
  message: PeriMessage;
  finishReason: string | null;
}

export interface PeriResponse {
  id: string;
  model: string;
  choices: PeriChoice[];
  usage: PeriUsage;
  created: number;
}

/** Streaming chunk */
export interface PeriStreamChunk {
  id: string;
  model: string;
  delta: Partial<PeriMessage>;
  finishReason: string | null;
  usage?: PeriUsage;
}

/** Result of a proxied call (used internally) */
export interface ProxyResult {
  response?: PeriResponse;
  stream?: ReadableStream<Uint8Array>;
  usage: PeriUsage;
  ttftMs?: number;
}
