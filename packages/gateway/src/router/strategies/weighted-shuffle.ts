/**
 * Weighted shuffle routing strategy (inspired by LiteLLM simple_shuffle).
 * Picks deployments randomly, weighted by their `weight` param.
 */
import type { ResolvedDeployment } from "../model-resolver.js";
import type { RoutingContext, RoutingStrategy } from "./base.js";

export const weightedShuffle: RoutingStrategy = {
  name: "weighted-shuffle",

  rank(deployments: ResolvedDeployment[], _context: RoutingContext): ResolvedDeployment[] {
    if (deployments.length <= 1) return deployments;

    // Fisher-Yates shuffle with weights
    const result = [...deployments];
    const weights = result.map((d) => d.weight);

    for (let i = result.length - 1; i > 0; i--) {
      // Weighted random pick from [0, i]
      const totalWeight = weights.slice(0, i + 1).reduce((a, b) => a + b, 0);
      let random = Math.random() * totalWeight;
      let pick = 0;

      for (let j = 0; j <= i; j++) {
        random -= weights[j];
        if (random <= 0) {
          pick = j;
          break;
        }
      }

      // Swap
      [result[i], result[pick]] = [result[pick], result[i]];
      [weights[i], weights[pick]] = [weights[pick], weights[i]];
    }

    return result;
  },
};
