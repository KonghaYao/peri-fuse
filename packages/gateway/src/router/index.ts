/**
 * Router — main entry point for model routing with failover.
 */
import type { PeriRequest, PeriStreamChunk, PeriUsage } from "../protocol/types.js";
import { createAdapter, ProviderError } from "../provider/registry.js";
import type { ProviderCallResult } from "../provider/base.js";
import { recordFailure, recordSuccess } from "./cooldown.js";
import { resolveModel, type ResolvedDeployment } from "./model-resolver.js";
import type { RoutingContext, RoutingStrategy } from "./strategies/base.js";
import { lowestLatency } from "./strategies/lowest-latency.js";
import { priorityStrategy } from "./strategies/priority.js";
import { weightedShuffle } from "./strategies/weighted-shuffle.js";

const strategies: Record<string, RoutingStrategy> = {
  "weighted-shuffle": weightedShuffle,
  "lowest-latency": lowestLatency,
  priority: priorityStrategy,
};

// Latency tracking for lowest-latency strategy
const latencyData = new Map<string, number[]>();
const MAX_LATENCY_SAMPLES = 10;

export function recordLatency(providerId: string, latencyMs: number): void {
  const samples = latencyData.get(providerId) ?? [];
  samples.push(latencyMs);
  if (samples.length > MAX_LATENCY_SAMPLES) {
    samples.shift();
  }
  latencyData.set(providerId, samples);
}

export interface RouteResult extends ProviderCallResult {
  deployment: ResolvedDeployment;
}

/**
 * Route a request to the best available deployment with failover.
 */
export async function routeRequest(
  req: PeriRequest,
  projectId: string,
  strategyName = "weighted-shuffle",
): Promise<RouteResult> {
  const deployments = await resolveModel(req.model, projectId);

  if (deployments.length === 0) {
    throw new RouterError(`No available deployments for model "${req.model}"`, 404);
  }

  // Rank deployments using the selected strategy
  const strategy = strategies[strategyName] ?? weightedShuffle;
  const context: RoutingContext = { model: req.model, latencyData };
  const ranked = strategy.rank(deployments, context);

  // Try each deployment in order (failover)
  let lastError: Error | null = null;

  for (const deployment of ranked) {
    try {
      const adapter = createAdapter(deployment.providerType, {
        baseUrl: deployment.baseUrl,
        apiKey: deployment.apiKey,
        timeout: deployment.timeout,
      });

      let result: ProviderCallResult;
      if (req.stream) {
        result = await adapter.callStream(req, deployment.providerModel);
      } else {
        result = await adapter.call(req, deployment.providerModel);
      }

      // Success — record and return
      recordSuccess(deployment.providerId);
      if (result.ttftMs) {
        recordLatency(deployment.providerId, result.ttftMs);
      }

      return { ...result, deployment };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[router] Deployment ${deployment.id} (${deployment.providerName}) failed: ${lastError.message}`,
      );

      // Record failure for cooldown tracking
      await recordFailure(deployment.providerId).catch(() => {});

      // Don't retry on client errors (4xx) — they won't succeed on another provider
      if (err instanceof ProviderError && err.statusCode >= 400 && err.statusCode < 500) {
        throw err;
      }
    }
  }

  throw new RouterError(
    `All deployments failed for model "${req.model}": ${lastError?.message ?? "unknown error"}`,
    502,
  );
}

export class RouterError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "RouterError";
    this.statusCode = statusCode;
  }
}
