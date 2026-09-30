/**
 * Provider adapter registry.
 * Maps provider type strings to adapter constructors.
 */
import { AnthropicAdapter } from "./anthropic.js";
import type { BaseProviderAdapter, ProviderConfig } from "./base.js";
import { OpenAIAdapter } from "./openai.js";

type AdapterConstructor = new (config: ProviderConfig) => BaseProviderAdapter;

const registry = new Map<string, AdapterConstructor>([
  ["openai", OpenAIAdapter],
  ["anthropic", AnthropicAdapter],
  ["custom", OpenAIAdapter], // custom uses OpenAI-compatible format
]);

/**
 * Create a provider adapter instance by type.
 */
export function createAdapter(type: string, config: ProviderConfig): BaseProviderAdapter {
  const Constructor = registry.get(type);
  if (!Constructor) {
    throw new Error(
      `Unknown provider type: "${type}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return new Constructor(config);
}

/**
 * Register a custom provider adapter type.
 */
export function registerAdapter(type: string, adapterConstructor: AdapterConstructor): void {
  registry.set(type, adapterConstructor);
}

export { BaseProviderAdapter, type ProviderConfig, ProviderError } from "./base.js";
