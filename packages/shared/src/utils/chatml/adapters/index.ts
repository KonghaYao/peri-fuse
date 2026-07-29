import type { NormalizerContext, ProviderAdapter } from "../types";
import { aisdkAdapter } from "./aisdk";
import { geminiAdapter } from "./gemini";
import { genericAdapter } from "./generic";
import { langgraphAdapter } from "./langgraph";
import { microsoftAgentAdapter } from "./microsoft-agent";
import { openAIAdapter } from "./openai";
import { pydanticAIAdapter } from "./pydantic-ai";
import { semanticKernelAdapter } from "./semantic-kernel";

const adapters: ProviderAdapter[] = [
  langgraphAdapter, // Must be before openAI (both use langfuse-sdk scope)
  aisdkAdapter, // Vercel AI SDK v5 (for all LLM providers like OpenAI, Bedrock, Anthropic, etc.)
  openAIAdapter, // OpenAI (Chat Completions & Responses API)
  geminiAdapter, // Gemini/VertexAI format
  microsoftAgentAdapter, // Microsoft Agent Framework
  pydanticAIAdapter, // Pydantic AI framework
  // Add more adapters here as needed
  semanticKernelAdapter, // Microsoft Semantic Kernel - detects by scope.name prefix
  genericAdapter, // Always last (fallback)
];

function selectAdapter(ctx: NormalizerContext): ProviderAdapter {
  // Explicit override
  if (ctx.framework) {
    const adapter = adapters.find((a) => a.id === ctx.framework);
    if (adapter) return adapter;
  }

  // First adapter that matches wins
  for (const adapter of adapters) {
    if (adapter.detect(ctx)) {
      return adapter;
    }
  }

  return genericAdapter;
}

export type { NormalizerContext, ProviderAdapter } from "../types";
export { aisdkAdapter } from "./aisdk";
export { geminiAdapter } from "./gemini";
export { genericAdapter } from "./generic";
export { langgraphAdapter } from "./langgraph";
export { microsoftAgentAdapter } from "./microsoft-agent";
export { openAIAdapter } from "./openai";
export { pydanticAIAdapter } from "./pydantic-ai";
export { semanticKernelAdapter } from "./semantic-kernel";
// Export selectAdapter and individual adapters for direct use
export { selectAdapter };
