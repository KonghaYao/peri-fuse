/**
 * Lowest latency routing strategy (inspired by LiteLLM lowest_latency).
 * Ranks deployments by their average recent latency.
 */
import type { ResolvedDeployment } from "../model-resolver.js";
import type { RoutingContext, RoutingStrategy } from "./base.js";

export const lowestLatency: RoutingStrategy = {
  name: "lowest-latency",

  rank(deployments: ResolvedDeployment[], context: RoutingContext): ResolvedDeployment[] {
    if (!context.latencyData || context.latencyData.size === 0) {
      // No latency data yet — fall back to weighted shuffle
      return [...deployments].sort(() => Math.random() - 0.5);
    }

    const getAvgLatency = (d: ResolvedDeployment): number => {
      const samples = context.latencyData!.get(d.providerId);
      if (!samples || samples.length === 0) return Infinity;
      return samples.reduce((a, b) => a + b, 0) / samples.length;
    };

    return [...deployments].sort((a, b) => getAvgLatency(a) - getAvgLatency(b));
  },
};
