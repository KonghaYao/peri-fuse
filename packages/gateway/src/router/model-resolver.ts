/**
 * Model resolver — resolves a model alias to available deployments.
 */
import { and, eq, ne } from "drizzle-orm";
import { modelDeployment, provider } from "../db/schema.js";
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
 * Resolve a model name to a list of available deployments within a project.
 * Filters out disabled providers and those in cooldown.
 */
export async function resolveModel(
  modelName: string,
  projectId: string,
): Promise<ResolvedDeployment[]> {
  const db = getDb();

  const rows = await db
    .select({
      deployment: modelDeployment,
      provider: provider,
    })
    .from(modelDeployment)
    .innerJoin(provider, eq(modelDeployment.providerId, provider.id))
    .where(
      and(
        eq(modelDeployment.modelName, modelName),
        eq(modelDeployment.isEnabled, true),
        eq(modelDeployment.projectId, projectId),
        eq(provider.isEnabled, true),
        eq(provider.projectId, projectId),
        ne(provider.status, "disabled"),
      ),
    );

  const now = new Date();

  return rows
    .filter(({ provider: p }) => {
      // Filter out providers in cooldown
      if (p.status === "cooldown" && p.cooldownUntil) {
        return now >= new Date(p.cooldownUntil);
      }
      // Filter out providers over budget
      if (p.budgetLimit != null && p.budgetSpend >= p.budgetLimit) {
        return false;
      }
      return true;
    })
    .map(({ deployment: d, provider: p }) => {
      const params = JSON.parse(d.litellmParams || "{}");
      const modelInfo = d.modelInfo ? JSON.parse(d.modelInfo) : {};

      // Resolve API key: from credential or direct
      let apiKey = "";
      if (p.apiKeyEncrypted) {
        try {
          apiKey = decrypt(p.apiKeyEncrypted);
        } catch {
          apiKey = "";
        }
      }

      return {
        id: d.id,
        modelName: d.modelName,
        providerModel: d.providerModel,
        providerId: p.id,
        providerName: p.name,
        providerType: p.type,
        baseUrl: p.baseUrl,
        apiKey,
        weight: params.weight ?? 1,
        priority: params.priority ?? 0,
        timeout: params.timeout,
        modelInfo,
      };
    });
}

/**
 * Get all unique model names within a project (for /v1/models endpoint).
 */
export async function listModels(projectId: string): Promise<string[]> {
  const db = getDb();
  const results = await db
    .selectDistinct({ modelName: modelDeployment.modelName })
    .from(modelDeployment)
    .innerJoin(provider, eq(modelDeployment.providerId, provider.id))
    .where(
      and(
        eq(modelDeployment.isEnabled, true),
        eq(modelDeployment.projectId, projectId),
        eq(provider.isEnabled, true),
        eq(provider.projectId, projectId),
      ),
    );
  return results.map((r) => r.modelName);
}
