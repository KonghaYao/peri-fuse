/**
 * Routing strategy interface.
 */
import type { ResolvedDeployment } from "../model-resolver.js";

export interface RoutingStrategy {
  name: string;
  /**
   * Sort/rank deployments for selection.
   * Returns deployments in priority order (first = preferred).
   */
  rank(deployments: ResolvedDeployment[], context: RoutingContext): ResolvedDeployment[];
}

export interface RoutingContext {
  model: string;
  // Latency data from recent requests (model -> provider -> latency samples)
  latencyData?: Map<string, number[]>;
}
