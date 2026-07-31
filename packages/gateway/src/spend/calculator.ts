/**
 * Cost calculator — computes spend from token counts and model pricing.
 */

interface ModelPricing {
  inputPrice?: number; // per million tokens (USD)
  outputPrice?: number; // per million tokens (USD)
}

/**
 * Calculate the cost of a request in USD.
 * Prices are per million tokens.
 */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  modelInfo: Record<string, unknown>,
): number {
  const pricing = modelInfo as ModelPricing;
  const inputPrice = pricing.inputPrice ?? 0;
  const outputPrice = pricing.outputPrice ?? 0;

  const inputCost = (promptTokens / 1_000_000) * inputPrice;
  const outputCost = (completionTokens / 1_000_000) * outputPrice;

  return inputCost + outputCost;
}
