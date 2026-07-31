/**
 * Priority routing strategy.
 * Sorts deployments by priority (lower = preferred), then by weight within same priority.
 */
import type { ResolvedDeployment } from "../model-resolver.js";
import type { RoutingContext, RoutingStrategy } from "./base.js";

export const priorityStrategy: RoutingStrategy = {
  name: "priority",

  rank(deployments: ResolvedDeployment[], _context: RoutingContext): ResolvedDeployment[] {
    return [...deployments].sort((a, b) => {
      // Lower priority number = higher preference
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Within same priority, higher weight first
      return b.weight - a.weight;
    });
  },
};
