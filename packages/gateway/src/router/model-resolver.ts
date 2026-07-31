/**
 * Model resolver — resolves a model alias to available deployments.
 */
import { getDb } from "../db.js";
import { decrypt } from "../utils/crypto.js";

export interface ResolvedDeployment {
  id: string;
  modelName: string;
  providerModel: string;
  providerId: string;
  providerName: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  weight: number;
  priority: number;
  timeout?: number;
  modelInfo: Record<string, unknown>;
}

/**
 * Resolve a model name to a list of available deployments.
 * Filters out disabled providers and those in cooldown.
 */
export async function resolveModel(modelName: string): Promise<ResolvedDeployment[]> {
  const db = getDb();

  const deployments = await db.modelDeployment.findMany({
    where: {
      modelName,
      isEnabled: true,
      provider: {
        isEnabled: true,
        status: { not: "disabled" },
      },
    },
    include: {
      provider: true,
    },
  });

  const now = new Date();

  return deployments
    .filter((d) => {
      // Filter out providers in cooldown
      if (d.provider.status === "cooldown" && d.provider.cooldownUntil) {
        return now >= d.provider.cooldownUntil;
      }
      // Filter out providers over budget
      if (d.provider.budgetLimit != null && d.provider.budgetSpend >= d.provider.budgetLimit) {
        return false;
      }
      return true;
    })
    .map((d) => {
      const params = JSON.parse(d.litellmParams || "{}");
      const modelInfo = d.modelInfo ? JSON.parse(d.modelInfo) : {};

      // Resolve API key: from credential or direct
      let apiKey = "";
      if (d.provider.apiKeyEncrypted) {
        try {
          apiKey = decrypt(d.provider.apiKeyEncrypted);
        } catch {
          apiKey = "";
        }
      }

      return {
        id: d.id,
        modelName: d.modelName,
        providerModel: d.providerModel,
        providerId: d.provider.id,
        providerName: d.provider.name,
        providerType: d.provider.type,
        baseUrl: d.provider.baseUrl,
        apiKey,
        weight: params.weight ?? 1,
        priority: params.priority ?? 0,
        timeout: params.timeout,
        modelInfo,
      };
    });
}

/**
 * Get all unique model names (for /v1/models endpoint).
 */
export async function listModels(): Promise<string[]> {
  const db = getDb();
  const results = await db.modelDeployment.findMany({
    where: { isEnabled: true, provider: { isEnabled: true } },
    select: { modelName: true },
    distinct: ["modelName"],
  });
  return results.map((r) => r.modelName);
}
